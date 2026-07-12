'use client';

import { getItem, setItem, removeItem, storageKeys } from '@/lib/storage';

const TOKEN_KEY         = storageKeys.token;
const REFRESH_TOKEN_KEY = storageKeys.refreshToken;

export function getToken(): string | null {
  return getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  setItem(TOKEN_KEY, token);
}

export function getRefreshToken(): string | null {
  return getItem(REFRESH_TOKEN_KEY);
}

export function setRefreshToken(token: string): void {
  setItem(REFRESH_TOKEN_KEY, token);
}

/**
 * Store both tokens at once — call this after login/register response.
 */
export function setAuthTokens(accessToken: string, refreshToken: string): void {
  setToken(accessToken);
  setRefreshToken(refreshToken);
}

export function clearToken(): void {
  removeItem(TOKEN_KEY);
  removeItem(REFRESH_TOKEN_KEY);
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
