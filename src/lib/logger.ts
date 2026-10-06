import pino from 'pino';
import type { Config } from '../config/env';

/** Structured JSON logs. Bodies are never logged, and credentials are redacted if a header slips in. */
export function createLogger(config: Config) {
  return pino({
    level: config.logLevel,
    base: { service: config.appName },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.passwordHash',
        '*.refreshToken',
        '*.accessToken',
        '*.idToken',
      ],
      censor: '[redacted]',
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
