import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generate } from './export-openapi';

/**
 * Builds postman/CalorieScan-AI.postman_collection.json from the route registry, so it always lists every endpoint.
 * Run `npm run postman`. Import it into Postman or Bruno, set `baseUrl`, then run "Auth > Register" first:
 * its test script stores the tokens, and later requests send them automatically.
 */

const ONBOARDING = {
  sex: 'female', workoutsPerWeek: 'light', referralSource: 'tiktok', heightCm: 167.6, weightKg: 54.0,
  birthDate: '2001-01-01', goal: 'maintain', targetWeightKg: null, triedOtherApps: true, worksWithProfessional: false,
  diet: 'balanced', accomplishment: 'eat_healthier', heightUnitPref: 'ft_in', weightUnitPref: 'kg', locale: 'en',
  timezone: 'Asia/Phnom_Penh', commitment: { committedAt: new Date().toISOString() },
};

/** Example bodies by "METHOD /path". Anything not listed is sent without a body. */
const BODIES: Record<string, unknown> = {
  'POST /auth/register': { email: 'me@example.com', password: 'correct horse battery', onboarding: ONBOARDING },
  'POST /auth/login': { email: 'me@example.com', password: 'correct horse battery' },
  'POST /auth/oauth/apple': { idToken: '<identity token from Sign in with Apple>' },
  'POST /auth/oauth/google': { idToken: '<ID token from Google Sign-In>' },
  'POST /auth/refresh': { refreshToken: '{{refreshToken}}' },
  'POST /auth/logout': { refreshToken: '{{refreshToken}}' },
  'POST /auth/password/forgot': { email: 'me@example.com' },
  'POST /auth/password/reset': { token: '<token from the email>', password: 'a brand new password' },
  'POST /onboarding/plan-preview': {
    sex: 'female', birthDate: '2001-01-01', heightCm: 167.6, weightKg: 54, workoutsPerWeek: 'light', goal: 'maintain', diet: 'balanced',
  },
  'POST /onboarding/complete': ONBOARDING,
  'PATCH /me/profile': { workoutsPerWeek: 'moderate' },
  'PATCH /me/preferences': { timezone: 'Asia/Phnom_Penh', weightUnitPref: 'kg', notificationsEnabled: true },
  'PUT /me/goals': { calories: 2000, proteinG: 130 },
  'POST /me/weight-logs': { weightKg: 54.2 },
  'POST /me/devices': { token: 'fcm-token-from-the-device-0123456789', platform: 'ios' },
  'POST /meals/barcode': { barcode: '3017620422003' },
  'POST /meals': { name: 'Greek yogurt', calories: 150, proteinG: 15, carbsG: 8, fatG: 5.5 },
  'PATCH /meals/:id': { quantity: 2 },
  'POST /meals/:id/fix': { instruction: 'that was chicken, not turkey, and no chips' },
};

const QUERIES: Record<string, Record<string, string>> = {
  'GET /dashboard/daily': { date: 'today' },
  'GET /analytics/summary': { range: '7d' },
  'GET /meals': { date: 'today', limit: '30' },
};

const captureTokens = [
  'const body = pm.response.json();',
  "if (body.tokens) { pm.collectionVariables.set('accessToken', body.tokens.accessToken); pm.collectionVariables.set('refreshToken', body.tokens.refreshToken); }",
];
const SCRIPTS: Record<string, string[]> = {
  'POST /auth/register': captureTokens,
  'POST /auth/login': captureTokens,
  'POST /auth/refresh': captureTokens,
  'POST /auth/oauth/apple': captureTokens,
  'POST /auth/oauth/google': captureTokens,
  'POST /meals/analyze': ["const m = pm.response.json().meal; if (m) pm.collectionVariables.set('mealId', m.id);"],
  'POST /meals': ["const m = pm.response.json().meal; if (m) pm.collectionVariables.set('mealId', m.id);"],
  'POST /meals/barcode': ["const m = pm.response.json().meal; if (m) pm.collectionVariables.set('mealId', m.id);"],
};

const { routes } = generate();
const folders = new Map<string, unknown[]>();

for (const r of routes) {
  const key = `${r.method.toUpperCase()} ${r.path}`;
  const prefix = r.root ? [] : ['api', 'v1'];
  const segments = r.path.split('/').filter(Boolean).map((s) => (s === ':id' ? '{{mealId}}' : s.startsWith(':') ? `{{${s.slice(1)}}}` : s));
  const query = QUERIES[key];
  const url = {
    raw: `{{baseUrl}}/${[...prefix, ...segments].join('/')}${query ? '?' + new URLSearchParams(query).toString() : ''}`,
    host: ['{{baseUrl}}'],
    path: [...prefix, ...segments],
    ...(query ? { query: Object.entries(query).map(([k, v]) => ({ key: k, value: v })) } : {}),
  };

  const header: { key: string; value: string; disabled?: boolean }[] = [];
  let body: unknown;
  if (r.multipart) {
    body = {
      mode: 'formdata',
      formdata: [
        { key: r.multipart.fileField, type: 'file', src: [] },
        { key: 'source', value: 'camera', type: 'text' },
        { key: 'hint', value: '', type: 'text', disabled: true },
      ],
    };
    header.push({ key: 'Idempotency-Key', value: '{{$guid}}' });
  } else if (BODIES[key] !== undefined) {
    body = { mode: 'raw', raw: JSON.stringify(BODIES[key], null, 2), options: { raw: { language: 'json' } } };
    header.push({ key: 'Content-Type', value: 'application/json' });
  }
  if (r.path.startsWith('/meals') || r.path === '/dashboard/daily') header.push({ key: 'X-Timezone', value: 'Asia/Phnom_Penh', disabled: true });

  const item = {
    name: `${r.summary}`,
    request: {
      method: r.method.toUpperCase(),
      header,
      url,
      ...(r.auth ? { auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] } } : { auth: { type: 'noauth' } }),
      ...(body ? { body } : {}),
      description: r.description ?? r.summary,
    },
    ...(SCRIPTS[key] ? { event: [{ listen: 'test', script: { type: 'text/javascript', exec: SCRIPTS[key] } }] } : {}),
  };
  const folder = r.tags[0] ?? 'Other';
  folders.set(folder, [...(folders.get(folder) ?? []), item]);
}

const order = ['Auth', 'Onboarding', 'Profile', 'Goals', 'Weight', 'Devices', 'Meals', 'Dashboard', 'Analytics', 'Ops'];
const collection = {
  info: {
    name: 'CalorieScan AI API',
    description:
      'Generated from the route registry (npm run postman). Start with Auth > Register; its test script stores the tokens. POST /meals/analyze: pick an image file in the form-data body, then poll GET /meals/{{mealId}}.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000' },
    { key: 'accessToken', value: '' },
    { key: 'refreshToken', value: '' },
    { key: 'mealId', value: '' },
    { key: 'token', value: '' },
  ],
  item: order.filter((f) => folders.has(f)).map((name) => ({ name, item: folders.get(name) })),
};

const out = resolve(__dirname, '../postman/CalorieScan-AI.postman_collection.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(collection, null, 2) + '\n');
console.log(`wrote ${out} (${routes.length} requests)`);
