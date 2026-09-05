/**
 * Strictly-validated environment for the sync worker.
 *
 * The worker takes its entire input from environment variables — that's
 * the contract whether it's launched as a child process locally or as an
 * Azure Container Apps Job execution. Variables prefix `WORKER_` so they
 * can never collide with anything the connector framework might read
 * itself.
 *
 * Validation is strict: missing or malformed envs result in an immediate
 * exit-1 before the connector even starts. The orchestrator is the only
 * thing that constructs these env vars, so validation failures here
 * indicate a real bug, not user error.
 */

import { z } from 'zod';

const envSchema = z.object({
  WORKER_CONNECTOR_TYPE: z.string().min(1),
  /**
   * Plaintext connector config JSON. Used by the LOCAL launcher (child
   * process in dev). In Azure / production, this is empty and the worker
   * uses `WORKER_CONFIG_BLOB_URL` instead — see worker/main.ts. Exactly
   * one of the two must be present; main.ts errors if both are missing.
   */
  WORKER_CONNECTOR_CONFIG: z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (!s) return undefined;
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `WORKER_CONNECTOR_CONFIG is not valid JSON: ${(e as Error).message}`,
        });
        return z.NEVER;
      }
    }),
  /**
   * SAS URL pointing at a private blob containing the connector config
   * as JSON. Used by the AZURE launcher in place of WORKER_CONNECTOR_CONFIG
   * so plaintext credentials never sit in env-var metadata that Azure
   * retains for ~30 days. The worker fetches + parses on startup, then
   * the orchestrator deletes the blob.
   */
  WORKER_CONFIG_BLOB_URL: z.string().url().optional(),
  /**
   * Absolute path to a file containing the connector config as JSON. Used by
   * the LOCAL launcher in place of `WORKER_CONNECTOR_CONFIG`.
   *
   * Two reasons it is a file rather than an env var. A config can be large —
   * a spreadsheet source carries the workbook's bytes, and Linux caps a
   * single env var at 128 KB, so an env var cannot hold one at all. And an
   * env var is readable from `/proc/<pid>/environ` by anything running as the
   * same user, whereas the file is written 0600 and deleted when the child
   * exits. The orchestrator writes it; the worker deletes it after reading.
   */
  WORKER_CONFIG_FILE: z.string().optional(),
  WORKER_ENTITIES: z
    .string()
    .min(1)
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  WORKER_TENANT_ID: z.string().min(1),
  WORKER_CONNECTION_ID: z.string().min(1),
  WORKER_SYNC_RUN_ID: z.string().min(1),
  /**
   * Where Parquet files land. Local dev: an absolute filesystem path.
   * Azure: a SAS-scoped Blob URL — the writer detects the prefix and
   * switches backends.
   */
  WORKER_WAREHOUSE_PATH: z.string().min(1),
  /**
   * Optional. SAS URL pointing at an append-blob the worker will mirror
   * every emitted event into. Used in Azure mode so the orchestrator
   * (which doesn't have stdout access to a Container Apps Job execution)
   * can poll the blob for live progress. Local mode leaves this unset
   * because stdout is captured directly.
   */
  WORKER_HEARTBEAT_URL: z.string().optional(),
  /**
   * Optional. Prior cursors for incrementally-synced entities, JSON-encoded
   * (a map of entityName → { type, value }). Empty string OR absent means
   * no prior cursors are known (initial sync). Connector decides which
   * entities to apply the cursor to.
   */
  /**
   * Optional. '1' = FULL RE-SYNC (P0-6): the connector ignores every prior
   * cursor and the writer REPLACES each table instead of merging into it.
   * The orchestrator has already reset the affected `entity_sync_cursors`.
   */
  WORKER_FULL_RESYNC: z.string().optional().transform((s) => s === '1'),
  WORKER_CURSORS: z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (!s) return {} as Record<string, { type: 'timestamp' | 'integer' | 'string'; value: string }>;
      try {
        return JSON.parse(s) as Record<string, { type: 'timestamp' | 'integer' | 'string'; value: string }>;
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `WORKER_CURSORS is not valid JSON: ${(e as Error).message}`,
        });
        return z.NEVER;
      }
    }),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Worker env validation failed: ${issues}`);
  }
  return result.data;
}
