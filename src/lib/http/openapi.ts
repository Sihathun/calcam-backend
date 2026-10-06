import { z, type ZodType } from 'zod';
import type { RouteDef } from './route';

type Json = Record<string, any>;

function toSchema(schema: ZodType, io: 'input' | 'output'): Json {
  const js = z.toJSONSchema(schema, { io, unrepresentable: 'any', target: 'draft-2020-12' }) as Json;
  delete js.$schema;
  return js;
}

const errorSchema: Json = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', examples: ['VALIDATION_ERROR'] },
        message: { type: 'string' },
        details: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'issue'],
            properties: { path: { type: 'string' }, issue: { type: 'string' } },
          },
        },
      },
    },
  },
};

const errorResponse = (description: string): Json => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
});

function parametersFrom(schema: ZodType | undefined, where: 'path' | 'query'): Json[] {
  if (!schema) return [];
  const js = toSchema(schema, 'input');
  const required = new Set<string>(js.required ?? []);
  return Object.entries((js.properties ?? {}) as Json).map(([name, s]) => ({
    name,
    in: where,
    required: where === 'path' ? true : required.has(name),
    schema: s,
  }));
}

export interface OpenApiOptions {
  title: string;
  version: string;
  description: string;
  serverUrl: string;
}

/** Builds an OpenAPI 3.1 document straight from the route registry, so docs and implementation cannot drift. */
export function buildOpenApi(routes: RouteDef[], opts: OpenApiOptions): Json {
  const paths: Json = {};

  for (const r of routes) {
    const path = (r.root ? '' : '/api/v1') + r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const op: Json = {
      summary: r.summary,
      tags: r.tags,
      operationId: `${r.method}_${r.path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      parameters: [...parametersFrom(r.params, 'path'), ...parametersFrom(r.query, 'query')],
      responses: {} as Json,
    };
    if (r.description) op.description = r.description;
    if (r.auth) op.security = [{ bearerAuth: [] }];
    else op.security = [];
    if (!op.parameters.length) delete op.parameters;

    if (r.multipart) {
      const bodySchema = r.body ? toSchema(r.body, 'input') : { type: 'object', properties: {} };
      const props = { ...(bodySchema.properties ?? {}) };
      props[r.multipart.fileField] = {
        type: 'string',
        format: 'binary',
        description: r.multipart.fileDescription,
      };
      op.requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: props,
              required: [r.multipart.fileField, ...(bodySchema.required ?? [])],
            },
          },
        },
      };
    } else if (r.body) {
      op.requestBody = { required: true, content: { 'application/json': { schema: toSchema(r.body, 'input') } } };
    }

    for (const [status, spec] of Object.entries(r.responses)) {
      op.responses[status] = Number(status) >= 400 && !spec.schema
        ? errorResponse(spec.description)
        : spec.schema
        ? { description: spec.description, content: { 'application/json': { schema: toSchema(spec.schema, 'output') } } }
        : { description: spec.description };
    }
    if (r.body || r.query || r.params) op.responses['400'] ??= errorResponse('Validation error');
    if (r.auth) op.responses['401'] ??= errorResponse('Missing, invalid or expired access token');
    if (r.limiter || r.auth) op.responses['429'] ??= errorResponse('Rate limit exceeded');

    paths[path] ??= {};
    paths[path][r.method] = op;
  }

  return {
    openapi: '3.1.0',
    info: { title: opts.title, version: opts.version, description: opts.description },
    servers: [{ url: opts.serverUrl }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: { ErrorResponse: errorSchema },
    },
  };
}
