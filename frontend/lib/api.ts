import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { getToken, getRefreshToken, setToken, clearToken } from './auth';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api',
});

// Attach access token to every request
api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ─── Refresh-token flow ─────────────────────────────────────────────────────
//
// Access tokens expire in 15 minutes. When that happens, the next request
// returns 401. Instead of bouncing the user to /login, we:
//   1. Try to swap the refresh token for a new access token via /auth/refresh
//   2. If that succeeds, store the new access token and retry the original
//   3. If it fails (refresh expired / revoked), clear everything and bounce
//
// Concurrent requests during a refresh share one in-flight refresh promise
// so we don't fire multiple /auth/refresh hits when N requests 401 at once.
// Each waiter retries with the new token once the refresh resolves.

let refreshInFlight: Promise<string | null> | null = null;

async function attemptRefresh(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  try {
    // Use a bare axios call here — going through `api` would trigger
    // this same interceptor recursively when the refresh request itself
    // 401s.
    const baseURL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';
    const res = await axios.post(
      `${baseURL}/auth/refresh`,
      { refreshToken },
      { headers: { 'Content-Type': 'application/json' } },
    );
    const newToken = (res.data?.data?.token ?? null) as string | null;
    if (newToken) setToken(newToken);
    return newToken;
  } catch {
    return null;
  }
}

api.interceptors.response.use(
  (res) => res,
  async (err: AxiosError) => {
    const originalRequest = err.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;

    // 401 on a request that hasn't already been retried → attempt refresh
    if (err.response?.status === 401 && originalRequest && !originalRequest._retried) {
      // Don't try to refresh the refresh request itself.
      const url = (originalRequest.url ?? '').toString();
      if (url.includes('/auth/refresh') || url.includes('/auth/login')) {
        clearToken();
        if (typeof window !== 'undefined') window.location.href = '/';
        return Promise.reject(err);
      }

      // Coalesce: one refresh in flight at a time. Other 401'd requests
      // wait for the same promise.
      if (!refreshInFlight) {
        refreshInFlight = attemptRefresh().finally(() => {
          // Clear the in-flight handle once it settles so the NEXT 401
          // (e.g. after the new access token also expires) can try again.
          setTimeout(() => { refreshInFlight = null; }, 0);
        });
      }

      const newToken = await refreshInFlight;
      if (!newToken) {
        clearToken();
        if (typeof window !== 'undefined') window.location.href = '/';
        return Promise.reject(err);
      }

      originalRequest._retried = true;
      originalRequest.headers = {
        ...(originalRequest.headers ?? {}),
        Authorization: `Bearer ${newToken}`,
      };
      return api.request(originalRequest);
    }

    if (err.response?.status === 401) {
      clearToken();
      if (typeof window !== 'undefined') window.location.href = '/';
    }
    return Promise.reject(err);
  },
);

export default api;
