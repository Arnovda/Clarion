/**
 * paginate.ts — Reusable pagination helper for list endpoints.
 *
 * Usage:
 *   const { page, limit, offset } = parsePagination(req.query);
 *   const rows = await db('table').limit(limit).offset(offset);
 *   const total = await db('table').count();
 *   res.json(paginatedResponse(rows, total, page, limit));
 */

import { Request } from 'express';

export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

export interface PaginatedResult<T> {
  ok: true;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

/**
 * Parse pagination params from query string.
 * Defaults: page=1, limit=50, max limit=200.
 */
export function parsePagination(
  query: Request['query'],
  defaults: { limit?: number; maxLimit?: number } = {},
): PaginationParams {
  const maxLimit = defaults.maxLimit ?? 200;
  const defaultLimit = defaults.limit ?? 50;

  const page  = Math.max(1, Math.floor(Number(query.page)  || 1));
  const limit = Math.max(1, Math.min(Math.floor(Number(query.limit) || defaultLimit), maxLimit));
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/**
 * Build a paginated response envelope.
 */
export function paginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedResult<T> {
  const totalPages = Math.ceil(total / limit);
  return {
    ok: true,
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}
