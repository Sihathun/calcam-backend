import { z } from 'zod';
import type { AppDeps } from '../../deps';
import { isoOutput } from '../../lib/dto';
import { devicePlatformSchema } from '../../lib/enums';
import { authRoute, reply, type RouteDef } from '../../lib/http/route';

const TAG = 'Devices';

export function devicesRoutes(deps: AppDeps): RouteDef[] {
  const { prisma, clock } = deps;
  return [
    authRoute({
      method: 'post',
      path: '/me/devices',
      tags: [TAG],
      summary: 'Register an FCM token for push notifications',
      description: 'Idempotent. A token that was registered by another user (shared device) moves to the caller.',
      body: z.object({ token: z.string().min(10).max(4096), platform: devicePlatformSchema }),
      responses: {
        200: {
          description: 'Registered',
          schema: z.object({ token: z.string(), platform: devicePlatformSchema, lastSeenAt: isoOutput }),
        },
      },
      handler: async ({ user, body }) => {
        const row = await prisma.deviceToken.upsert({
          where: { token: body.token },
          create: { userId: user.id, token: body.token, platform: body.platform, lastSeenAt: clock() },
          update: { userId: user.id, platform: body.platform, lastSeenAt: clock() },
        });
        return { token: row.token, platform: row.platform, lastSeenAt: row.lastSeenAt.toISOString() };
      },
    }),

    authRoute({
      method: 'delete',
      path: '/me/devices/:token',
      tags: [TAG],
      summary: 'Unregister an FCM token (call on logout)',
      description: 'Idempotent. Only the caller\'s own tokens are affected.',
      params: z.object({ token: z.string().min(1).max(4096) }),
      responses: { 204: { description: 'Unregistered' } },
      handler: async ({ user, params }) => {
        await prisma.deviceToken.deleteMany({ where: { userId: user.id, token: params.token } });
        return reply(204);
      },
    }),
  ];
}
