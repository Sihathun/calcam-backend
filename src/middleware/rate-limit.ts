import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { AppDeps } from '../deps';
import { AppError } from '../lib/errors';
import type { LimiterName } from '../lib/http/route';

interface LimiterSet {
  /** General per-user limit applied to every authenticated route. */
  userLimiter: RequestHandler;
  limiters: Record<LimiterName, RequestHandler>;
}

export function createLimiters(deps: Pick<AppDeps, 'config' | 'redis'>): LimiterSet {
  const { config, redis } = deps;

  const make = (name: string, limit: number, windowMs: number, key: 'ip' | 'user'): RequestHandler => {
    // Tests run many requests from one address; the dedicated limiter test builds its own app with low limits.
    const store: Store | undefined =
      redis && config.rateLimit.store === 'redis'
        ? new RedisStore({
            prefix: `rl:${name}:`,
            sendCommand: (...args: string[]) => redis.call(args[0]!, ...args.slice(1)) as Promise<any>,
          })
        : undefined;
    return rateLimit({
      windowMs,
      limit,
      store,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => (key === 'user' && req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip ?? '')),
      handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.')),
    });
  };

  const MINUTE = 60_000;
  const rl = config.rateLimit;
  return {
    userLimiter: make('general', rl.generalPerMin, MINUTE, 'user'),
    limiters: {
      auth: make('auth', rl.authPerMin, MINUTE, 'ip'),
      planPreview: make('plan-preview', rl.planPreviewPerMin, MINUTE, 'ip'),
      analyze: make('analyze', rl.analyzePerHour, 60 * MINUTE, 'user'),
    },
  };
}
