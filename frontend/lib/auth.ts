'use client';

const TOKEN_KEY         = 'clarion_token';
const REFRESH_TOKEN_KEY = 'clarion_refresh_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setRefreshToken(token: string): void {
  localStorage.setItem(REFRESH_TOKEN_KEY, token);
}

/**
 * Store both tokens at once — call this after login/register response.
 */
export function setAuthTokens(accessToken: string, refreshToken: string): void {
  setToken(accessToken);
  setRefreshToken(refreshToken);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

export interface TokenPayload {
  sub: number;
  tenantId: number;
  email: string;
  displayName: string;
  role: 'admin' | 'analyst' | 'viewer';
  exp: number;
}

export function getTokenPayload(): TokenPayload | null {
  const token = getToken();
  if (!token) return null;
  try {
    const base64 = token.split('.')[1];
    return JSON.parse(atob(base64)) as TokenPayload;
  } catch {
    return null;
  }
}

export function isAdmin(): boolean {
  return getTokenPayload()?.role === 'admin';
}
