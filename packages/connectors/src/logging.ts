/**
 * Logger implementations for connectors.
 *
 * Two production loggers and one test helper:
 *   • createStdoutLogger — JSON lines to stdout. Used by the sync-worker
 *     container; Container Apps streams stdout to Log Analytics.
 *   • createBackendLogger — wraps Clarion's existing pino instance.
 *     Used for in-process testConnection/listEntities calls.
 *   • createNoopLogger — for tests.
 *
 * All three pass log entries through `redact()` before emission. Redaction
 * is best-effort string scrubbing; the real defence in depth is that
 * connectors are forced to use these loggers (the contract gives them
 * `ctx.log` and nothing else) and HttpClient strips credentials from URLs
 * + structured error excerpts before they ever reach a logger call.
 */

import type { Logger } from './types';

// ─── Redaction ────────────────────────────────────────────────────────────
/**
 * Patterns that strongly suggest a secret is in the string. Conservative —
 * better to over-redact than leak. Each pattern replaces only the secret
 * portion, not the whole line, so log lines remain useful.
 */
type ReplaceFn = (...m: string[]) => string;
const REDACTION_PATTERNS: Array<{ re: RegExp; replace: string | ReplaceFn }> = [
  // Bearer tokens in Authorization headers
  { re: /Bearer\s+[A-Za-z0-9._\-+/]+=*/g, replace: 'Bearer <redacted>' },
  // OAuth-shaped key=value pairs
  { re: /(client_secret|client_id|refresh_token|access_token|api_key|apikey|password)=([^\s&"]+)/gi,
    replace: '$1=<redacted>' },
  // JSON-shaped credential fields
  { re: /"(client_secret|client_id|refresh_token|access_token|api_key|apikey|password)"\s*:\s*"[^"]*"/gi,
    replace: '"$1":"<redacted>"' },
  // Long opaque tokens that look like JWTs / API keys (40+ chars, base64-ish).
  // Backstop for log lines that include raw token strings without a label.
  { re: /\b[A-Za-z0-9._\-+/]{40,}=*\b/g, replace: '<redacted-token>' },
];

export function redact(input: string): string {
  let out = input;
  for (const { re, replace } of REDACTION_PATTERNS) {
    out = typeof replace === 'string'
      ? out.replace(re, replace)
      : out.replace(re, replace);
  }
  return out;
}

/** Recursively redact string values inside a structured-log fields object. */
export function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return fields;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = redactValue(k, v);
  }
  return out;
}

function redactValue(key: string, v: unknown): unknown {
  // Field-name based: any field whose key name screams "secret" gets nuked
  // regardless of contents, even if the contents look benign.
  const SENSITIVE_KEYS = /(secret|token|password|apikey|api_key|authorization|cookie)/i;
  if (SENSITIVE_KEYS.test(key)) {
    return v == null ? v : '<redacted>';
  }
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map((item) => redactValue(key, item));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(k, val);
    }
    return out;
  }
  return v;
}

// ─── Loggers ──────────────────────────────────────────────────────────────
type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: Level;
  ts: string;
  msg: string;
  fields?: Record<string, unknown>;
}

function emit(entry: LogEntry, sink: (line: string) => void): void {
  const safe: LogEntry = {
    level: entry.level,
    ts: entry.ts,
    msg: redact(entry.msg),
    fields: redactFields(entry.fields),
  };
  sink(JSON.stringify(safe));
}

/**
 * Stdout JSON-lines logger for the sync-worker container.
 *
 * Container Apps captures stdout and forwards it to Log Analytics. Each
 * line is parseable — Log Analytics indexes the JSON fields automatically.
 */
export function createStdoutLogger(staticFields: Record<string, unknown> = {}): Logger {
  const make = (level: Level) => (msg: string, fields?: Record<string, unknown>): void => {
    emit(
      {
        level,
        ts: new Date().toISOString(),
        msg,
        fields: { ...staticFields, ...(fields ?? {}) },
      },
      (line) => process.stdout.write(`${line}\n`),
    );
  };
  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
  };
}

/**
 * Adapter for Clarion's backend Pino logger. The backend wires this in
 * so connector-method calls (testConnection, listEntities) flow through the
 * same structured-log pipeline as the rest of the API.
 */
export function createAdapterLogger(target: {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}, staticFields: Record<string, unknown> = {}): Logger {
  const make = (level: Level) => (msg: string, fields?: Record<string, unknown>): void => {
    const safeMsg = redact(msg);
    const safeFields = redactFields({ ...staticFields, ...(fields ?? {}) }) ?? {};
    target[level](safeFields, safeMsg);
  };
  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
  };
}

/**
 * No-op logger for tests / contexts where logging would be noise.
 * Use sparingly — production code paths should always have a real logger.
 */
export function createNoopLogger(): Logger {
  const noop = (): void => { /* intentionally empty */ };
  return { debug: noop, info: noop, warn: noop, error: noop };
}
