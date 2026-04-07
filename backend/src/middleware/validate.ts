/**
 * validate.ts — Zod-based request validation middleware.
 *
 * Usage:
 *   import { validate } from '../middleware/validate';
 *   import { z } from 'zod';
 *
 *   const schema = z.object({ body: z.object({ name: z.string() }) });
 *   router.post('/foo', validate(schema), handler);
 */

import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * Returns Express middleware that validates `req.body`, `req.query`, and `req.params`
 * against a Zod schema. The schema should use `z.object({ body?, query?, params? })`.
 *
 * On validation failure: returns 400 with structured error details.
 * On success: replaces req.body/query/params with the parsed (coerced) values.
 */
export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse({
      body:   req.body,
      query:  req.query,
      params: req.params,
    });

    if (!result.success) {
      const errors = formatZodErrors(result.error);
      res.status(400).json({
        ok: false,
        error: 'Validation failed',
        details: errors,
      });
      return;
    }

    // Replace with parsed (coerced) values
    const data = result.data as { body?: unknown; query?: unknown; params?: unknown };
    if (data.body)   req.body   = data.body;
    if (data.query)  req.query  = data.query as Record<string, string>;
    if (data.params) req.params = data.params as Record<string, string>;
    next();
  };
}

function formatZodErrors(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path:    issue.path.join('.'),
    message: issue.message,
  }));
}
