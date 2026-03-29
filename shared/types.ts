// Shared TypeScript types used by both backend and frontend

export type UserRole = 'epicdata_admin' | 'client_user';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
}

export interface JwtPayload {
  sub: string;
  username: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

// API response envelope
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
