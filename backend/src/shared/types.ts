// Shared TypeScript types used by both backend and frontend

// Roles: admin = full access, analyst = query + dashboards + reports, viewer = read-only
export type UserRole = 'admin' | 'analyst' | 'viewer';

export interface AuthUser {
  id: number;
  tenantId: number;
  email: string;
  displayName: string;
  role: UserRole;
}

export interface JwtPayload {
  sub: number;          // user id
  tenantId: number;     // tenant id
  email: string;
  displayName: string;
  name?: string;        // alias for displayName (used in route handlers)
  role: UserRole;
  iat?: number;
  exp?: number;
  [key: string]: unknown; // allow additional properties
}

// API response envelope
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
