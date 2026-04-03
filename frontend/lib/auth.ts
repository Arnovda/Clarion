'use client';

const TOKEN_KEY = 'databridge_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
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
