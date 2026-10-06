import type { Request, RequestHandler, Response, Router } from 'express';
import { z, type ZodType } from 'zod';
import { AppError, type ErrorDetail } from '../errors';

export interface AuthUser {
  id: string;
  timezone: string;
  locale: string;
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Names of the rate limiters the app builds (see middleware/rate-limit.ts). */
export type LimiterName = 'auth' | 'planPreview' | 'analyze';

export interface ResponseSpec {
  description: string;
  schema?: ZodType;
}

/** Wrap a handler return value to choose a non-default status code. */
export class Reply {
  constructor(
    public readonly status: number,
    public readonly body?: unknown,
  ) {}
}
export const reply = (status: number, body?: unknown) => new Reply(status, body);

interface BaseSpec<P extends ZodType, Q extends ZodType, B extends ZodType> {
  method: HttpMethod;
  /** Relative to /api/v1. Express syntax, e.g. "/meals/:id". */
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  params?: P;
  query?: Q;
  body?: B;
  /** Marks the body as multipart/form-data with one file field. `body` then describes the text fields. */
  multipart?: { fileField: string; fileDescription: string };
  /** Status code -> response. The lowest 2xx is the default status. */
  responses: Record<number, ResponseSpec>;
  limiter?: LimiterName;
  /** Mount at the server root (health, docs) instead of under /api/v1. */
  root?: boolean;
}

export interface PublicSpec<P extends ZodType, Q extends ZodType, B extends ZodType> extends BaseSpec<P, Q, B> {
  handler: (ctx: PublicContext<z.output<P>, z.output<Q>, z.output<B>>) => Promise<unknown>;
}

export interface AuthedSpec<P extends ZodType, Q extends ZodType, B extends ZodType> extends BaseSpec<P, Q, B> {
  handler: (ctx: AuthedContext<z.output<P>, z.output<Q>, z.output<B>>) => Promise<unknown>;
}

export interface PublicContext<P, Q, B> {
  req: Request;
  res: Response;
  params: P;
  query: Q;
  body: B;
  file?: Express.Multer.File;
}

export interface AuthedContext<P, Q, B> extends PublicContext<P, Q, B> {
  user: AuthUser;
}

type Empty = ZodType<Record<string, never>>;

/** Type-erased route stored in the registry. */
export interface RouteDef {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: boolean;
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  multipart?: { fileField: string; fileDescription: string };
  responses: Record<number, ResponseSpec>;
  limiter?: LimiterName;
  root?: boolean;
  handler: (ctx: AuthedContext<any, any, any>) => Promise<unknown>;
}

export function publicRoute<
  P extends ZodType = Empty,
  Q extends ZodType = Empty,
  B extends ZodType = Empty,
>(spec: PublicSpec<P, Q, B>): RouteDef {
  return { ...spec, auth: false, handler: spec.handler as RouteDef['handler'] };
}

export function authRoute<
  P extends ZodType = Empty,
  Q extends ZodType = Empty,
  B extends ZodType = Empty,
>(spec: AuthedSpec<P, Q, B>): RouteDef {
  return { ...spec, auth: true, handler: spec.handler as RouteDef['handler'] };
}

function parsePart(schema: ZodType | undefined, value: unknown): unknown {
  if (!schema) return undefined;
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const details: ErrorDetail[] = result.error.issues.map((i) => ({
    path: i.path.join('.') || '(root)',
    issue: i.message,
  }));
  throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
}

export interface MountOptions {
  authenticate: RequestHandler;
  userLimiter: RequestHandler;
  limiters: Record<LimiterName, RequestHandler>;
  upload: (fileField: string) => RequestHandler;
}

function defaultStatus(responses: Record<number, ResponseSpec>): number {
  const ok = Object.keys(responses)
    .map(Number)
    .filter((s) => s >= 200 && s < 300)
    .sort((a, b) => a - b);
  return ok[0] ?? 200;
}

export function mountRoutes(router: Router, routes: RouteDef[], opts: MountOptions): void {
  for (const r of routes) {
    const chain: RequestHandler[] = [];
    if (r.auth) chain.push(opts.authenticate, opts.userLimiter);
    if (r.limiter) chain.push(opts.limiters[r.limiter]);
    if (r.multipart) chain.push(opts.upload(r.multipart.fileField));

    const fallbackStatus = defaultStatus(r.responses);

    const handle = async (req: Request, res: Response) => {
      const ctx = {
        req,
        res,
        user: (req as Request & { user?: AuthUser }).user as AuthUser,
        params: parsePart(r.params, req.params),
        query: parsePart(r.query, req.query),
        body: parsePart(r.body, req.body),
        file: req.file,
      };
      const out = await r.handler(ctx);
      if (res.headersSent) return; // the handler wrote the response itself (e.g. /metrics)
      const status = out instanceof Reply ? out.status : fallbackStatus;
      const data = out instanceof Reply ? out.body : out;
      const spec = r.responses[status];
      if (!spec) throw new Error(`${r.method.toUpperCase()} ${r.path} returned undocumented status ${status}`);
      if (status === 204 || data === undefined) {
        res.status(status).end();
        return;
      }
      // Parsing the output keeps the OpenAPI document honest and strips fields that are not part of the contract.
      const payload = spec.schema ? spec.schema.parse(data) : data;
      res.status(status).json(payload);
    };

    router[r.method](r.path, ...chain, handle as RequestHandler);
  }
}

