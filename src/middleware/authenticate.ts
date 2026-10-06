import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { AppDeps } from '../deps';
import { unauthorized } from '../lib/errors';

/** Verifies the Bearer access token and loads the (non-deleted) user. Every handler then scopes queries by req.user.id. */
export function createAuthenticate(deps: Pick<AppDeps, 'config' | 'prisma'>): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) throw unauthorized();

    let sub: string;
    try {
      const payload = jwt.verify(token, deps.config.auth.accessSecret, { algorithms: ['HS256'] });
      if (typeof payload === 'string' || typeof payload.sub !== 'string') throw new Error('bad payload');
      sub = payload.sub;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw unauthorized('TOKEN_EXPIRED', 'The access token has expired');
      throw unauthorized('INVALID_TOKEN', 'The access token is invalid');
    }

    const user = await deps.prisma.user.findFirst({
      where: { id: sub, deletedAt: null },
      select: { id: true, timezone: true, locale: true },
    });
    if (!user) throw unauthorized('INVALID_TOKEN', 'The access token is invalid');
    req.user = user;
    next();
  };
}
