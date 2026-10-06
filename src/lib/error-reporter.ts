import type { Logger } from 'pino';
import type { Config } from '../config/env';

export interface ErrorReporter {
  capture(err: unknown, context?: Record<string, unknown>): void;
}

export const noopReporter: ErrorReporter = { capture() {} };

/** Sentry hook, active only when SENTRY_DSN is set. */
export async function createErrorReporter(config: Config, logger: Logger): Promise<ErrorReporter> {
  if (!config.sentryDsn) return noopReporter;
  const Sentry = await import('@sentry/node');
  Sentry.init({ dsn: config.sentryDsn, environment: config.env });
  logger.info('Sentry error reporting enabled');
  return {
    capture(err, context) {
      Sentry.withScope((scope) => {
        if (context) scope.setExtras(context);
        Sentry.captureException(err);
      });
    },
  };
}
