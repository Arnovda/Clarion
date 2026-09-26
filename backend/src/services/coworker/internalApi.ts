/**
 * The coworker's hands: the SAME routes the screens call, called as the user.
 *
 * Every tool that reads or checks something goes through an existing HTTP
 * route of this very process, with the caller's own bearer token. That is the
 * design, not a shortcut:
 *
 *   - the coworker can never do more than the person's own session could —
 *     requireAuth, requireRole, the tenant context, the ownership gates, the
 *     data policies and the SQL guard all apply exactly as they do on screen;
 *   - there is no second implementation of any rule to drift apart from the
 *     first (the lesson of the dual-write contract, applied before the fact);
 *   - taking the coworker away removes nothing the product depends on.
 *
 * Writes are NOT made here. A tool PROPOSES; the person's Keep in the panel
 * calls the write route from the browser, the same call the screens make.
 *
 * Loopback over 127.0.0.1 to the port this process listens on. Tests point it
 * at an ephemeral server with `setInternalApiBase`.
 */
import { config } from '../../config';

let baseOverride: string | null = null;

/** Tests only: where the loopback calls go. `null` restores the default. */
export function setInternalApiBase(url: string | null): void {
  baseOverride = url;
}

function base(): string {
  return baseOverride ?? `http://127.0.0.1:${config.port}/api`;
}

export interface InternalCaller {
  /** The incoming request's `Authorization` header, forwarded verbatim. */
  authorization: string;
  /** The incoming request's id, so the loopback calls correlate in the logs. */
  requestId?: string;
  signal?: AbortSignal;
}

export interface InternalResponse {
  status: number;
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error: string | null;
  /** A route's optional `detail` next to its error (e.g. the database's own words, for curators). */
  detail: string | null;
}

/** One route, per call; a slow route is abandoned rather than stalling a turn. */
const TIMEOUT_MS = Number(process.env.COWORKER_TOOL_TIMEOUT_MS) || 60_000;

export async function internalCall(
  caller: InternalCaller,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<InternalResponse> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = caller.signal ? AbortSignal.any([caller.signal, timeout]) : timeout;
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: {
      Authorization: caller.authorization,
      'Content-Type': 'application/json',
      ...(caller.requestId ? { 'X-Request-ID': caller.requestId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try { json = await res.json(); } catch { /* a non-JSON answer is reported by status */ }
  const ok = res.ok && json?.ok !== false;
  return {
    status: res.status,
    ok,
    data: json?.data ?? null,
    error: ok ? null : String(json?.error ?? `The request failed (${res.status})`),
    detail: ok || typeof json?.detail !== 'string' ? null : json.detail,
  };
}
