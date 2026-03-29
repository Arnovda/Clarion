import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Log full error server-side — never expose internals to the client
  console.error('[ErrorHandler]', err);
  res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
}
