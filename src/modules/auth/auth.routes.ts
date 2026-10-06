import { publicRoute, reply, type RouteDef } from '../../lib/http/route';
import type { AuthService } from './auth.service';
import {
  authResponseSchema,
  forgotBodySchema,
  loginBodySchema,
  oauthBodySchema,
  refreshBodySchema,
  registerBodySchema,
  resetBodySchema,
  statusSchema,
} from './auth.schemas';

const TAG = 'Auth';

export function authRoutes(svc: AuthService): RouteDef[] {
  return [
    publicRoute({
      method: 'post',
      path: '/auth/register',
      tags: [TAG],
      summary: 'Create an account (optionally with the whole onboarding payload)',
      description:
        'When `onboarding` is present, the profile, nutrition goal, first weight log and commitment are stored in the same transaction as the account, so signing up after the funnel is a single call.',
      limiter: 'auth',
      body: registerBodySchema,
      responses: {
        201: { description: 'Account created', schema: authResponseSchema },
        409: { description: 'EMAIL_TAKEN' },
        422: { description: 'Onboarding payload rejected (GOAL_NOT_SUPPORTED, UNDER_MINIMUM_AGE...)' },
      },
      handler: async ({ body }) => svc.register(body),
    }),

    publicRoute({
      method: 'post',
      path: '/auth/login',
      tags: [TAG],
      summary: 'Sign in with email and password',
      limiter: 'auth',
      body: loginBodySchema,
      responses: {
        200: { description: 'Signed in', schema: authResponseSchema },
        401: { description: 'INVALID_CREDENTIALS' },
      },
      handler: async ({ body }) => svc.login(body),
    }),

    publicRoute({
      method: 'post',
      path: '/auth/oauth/apple',
      tags: [TAG],
      summary: 'Sign in with Apple',
      description: 'Verifies the identity token server-side, then creates or links the user.',
      limiter: 'auth',
      body: oauthBodySchema,
      responses: {
        200: { description: 'Signed in', schema: authResponseSchema },
        401: { description: 'INVALID_ID_TOKEN' },
        503: { description: 'OAUTH_NOT_CONFIGURED' },
      },
      handler: async ({ body }) => svc.oauth('apple', body),
    }),

    publicRoute({
      method: 'post',
      path: '/auth/oauth/google',
      tags: [TAG],
      summary: 'Sign in with Google',
      description: 'Verifies the identity token server-side, then creates or links the user.',
      limiter: 'auth',
      body: oauthBodySchema,
      responses: {
        200: { description: 'Signed in', schema: authResponseSchema },
        401: { description: 'INVALID_ID_TOKEN' },
        503: { description: 'OAUTH_NOT_CONFIGURED' },
      },
      handler: async ({ body }) => svc.oauth('google', body),
    }),

    publicRoute({
      method: 'post',
      path: '/auth/refresh',
      tags: [TAG],
      summary: 'Rotate the refresh token',
      description:
        'Returns a new access token and a new refresh token. The old refresh token stops working. Presenting an already-rotated token revokes the whole token family (REFRESH_TOKEN_REUSED).',
      limiter: 'auth',
      body: refreshBodySchema,
      responses: {
        200: { description: 'New token pair', schema: authResponseSchema },
        401: { description: 'INVALID_REFRESH_TOKEN or REFRESH_TOKEN_REUSED' },
      },
      handler: async ({ body }) => svc.refresh(body.refreshToken),
    }),

    publicRoute({
      method: 'post',
      path: '/auth/logout',
      tags: [TAG],
      summary: 'Revoke the refresh token',
      description: 'Idempotent. Also unregister the FCM token with DELETE /me/devices/{token}.',
      limiter: 'auth',
      body: refreshBodySchema,
      responses: { 204: { description: 'Signed out' } },
      handler: async ({ body }) => {
        await svc.logout(body.refreshToken);
        return reply(204);
      },
    }),

    publicRoute({
      method: 'post',
      path: '/auth/password/forgot',
      tags: [TAG],
      summary: 'Email a password reset link',
      description: 'Behind FEATURE_PASSWORD_RESET. Always answers 202, whether or not the email has an account.',
      limiter: 'auth',
      body: forgotBodySchema,
      responses: {
        202: { description: 'Accepted', schema: statusSchema },
        404: { description: 'FEATURE_DISABLED' },
      },
      handler: async ({ body }) => {
        await svc.forgotPassword(body.email);
        return reply(202, { status: 'ok' });
      },
    }),

    publicRoute({
      method: 'post',
      path: '/auth/password/reset',
      tags: [TAG],
      summary: 'Choose a new password with a reset token',
      description: 'Behind FEATURE_PASSWORD_RESET. Signs the user out of every device.',
      limiter: 'auth',
      body: resetBodySchema,
      responses: {
        204: { description: 'Password changed' },
        400: { description: 'INVALID_RESET_TOKEN' },
        404: { description: 'FEATURE_DISABLED' },
      },
      handler: async ({ body }) => {
        await svc.resetPassword(body.token, body.password);
        return reply(204);
      },
    }),
  ];
}
