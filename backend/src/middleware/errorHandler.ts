import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Log full error server-side — never expose internals to the client
  console.error('[ErrorHandler]', err);

  // For admin users in non-production, include the error message for debugging
  const isAdmin = req.user?.role === 'admin';
  const isDev = process.env.NODE_ENV !== 'production';
  const message = (isDev && isAdmin && err instanceof Error)
    ? err.message
    : 'Something went wrong. Please try again.';

  res.status(500).json({ ok: false, error: message });
}
