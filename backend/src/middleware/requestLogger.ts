/**
 * requestLogger.ts — Request ID + response time + structured request logging.
 *
 * Adds:
 *  - X-Request-ID header (generated or forwarded from client/load balancer)
 *  - req.requestId available in all downstream handlers
 *  - req.log — a Pino child logger with requestId, method, url bound
 *  - Response time logged on finish
 *  - Integrates with Application Insights trackMetric
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger, createChildLogger } from '../utils/logger';
import { trackMetric } from '../utils/monitoring';

// Extend Express Request to include our additions
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      log: ReturnType<typeof createChildLogger>;
    }
  }
}

/**
 * Middleware that assigns a request ID, creates a scoped logger,
 * and logs request start + finish with response time.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  // Use existing request ID from upstream proxy/client, or generate one
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  // Create a child logger with request context
  const bindings: Record<string, unknown> = {
    requestId,
    method: req.method,
    url:    req.originalUrl,
  };

  // Add user context if available (set by auth middleware later, but
  // we check in case auth runs before this in some configurations)
  if (req.user) {
    bindings.userId   = req.user.sub;
    bindings.tenantId = req.user.tenantId;
  }

  req.log = createChildLogger(bindings);

  const start = process.hrtime.bigint();

  // Log on response finish
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const statusCode = res.statusCode;

    // Add user context that was set by auth middleware during request
    const logContext: Record<string, unknown> = {
      statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      contentLength: res.getHeader('content-length'),
    };

    if (req.user) {
      logContext.userId   = req.user.sub;
      logContext.tenantId = req.user.tenantId;
    }

    // Log at appropriate level based on status code
    if (statusCode >= 500) {
      req.log.error(logContext, 'request failed');
    } else if (statusCode >= 400) {
      req.log.warn(logContext, 'request error');
    } else {
      // Skip noisy health checks at info level
      if (req.originalUrl === '/api/health') {
        req.log.trace(logContext, 'request completed');
      } else {
        req.log.info(logContext, 'request completed');
      }
    }

    // Track response time metric in Application Insights
    trackMetric('api_response_time_ms', durationMs, {
      method:     req.method,
      route:      req.route?.path ?? req.originalUrl,
      statusCode: String(statusCode),
    });
  });

  next();
}
