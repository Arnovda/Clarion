/**
 * logger.ts — Structured logging with Pino.
 *
 * Usage:
 *   import { logger } from '../utils/logger';
 *   logger.info({ connectionId: 1 }, 'Schema profiling started');
 *   logger.error({ err }, 'AI call failed');
 *
 * In development: pretty-printed with colors.
 * In production: JSON lines for log aggregation (Azure Monitor, ELK, etc.).
 *
 * Every log entry automatically includes: level, time, pid, hostname.
 * Request-scoped logs include: requestId, method, url, userId, tenantId.
 */

import pino from 'pino';
import { getCorrelation } from './requestScope';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  // CORRELATION (assessment 6-1): every line emitted inside a request or a
  // job scope carries requestId / jobId / queue, whichever the scope holds.
  // Bound per line, not per child logger, so no call site has to remember.
  mixin: () => getCorrelation(),
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
  // Redact sensitive fields from log output
  redact: {
    paths: [
      'req.headers.authorization',
      'password',
      'password_hash',
      'token',
      'config.password',
      'config.credentials',
      'ANTHROPIC_API_KEY',
    ],
    censor: '[REDACTED]',
  },
});

/**
 * Create a child logger with bound context (e.g. requestId, tenantId).
 * Used by the request ID middleware to create per-request loggers.
 */
export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

export default logger;
