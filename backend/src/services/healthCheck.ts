/**
 * healthCheck.ts — the deep health check behind GET /api/health.
 *
 * WHY THIS EXISTS (market-readiness P0-6): deploy.yml promotes a new backend
 * revision automatically once it answers 200 on /api/health, and until
 * 2026-09-01 that answer proved only that Postgres was reachable. A revision
 * with Redis, Neo4j, blob storage or the jobs-worker dead reported `200 ok`
 * and took 100% of traffic with nobody watching. This module is what the
 * promote gate now actually asks.
 *
 * WHAT IT CHECKS
 *   postgres              SELECT 1 on the semantic pool (as before)
 *   redis                 PING on the shared BullMQ connection
 *   neo4j                 RETURN 1 through the driver
 *   blob                  service-properties read on the warehouse account
 *   worker_transformation someone is LISTENING on the transformation queue —
 *                         BullMQ's getWorkers() reads Redis CLIENT LIST, so
 *                         this measures the jobs-worker's liveness directly
 *                         instead of trusting a self-reported heartbeat
 *   worker_bus_matrix     same for the bus-matrix queue (API-side workers)
 *
 * THE STATUS VOCABULARY IS THREE-VALUED ON PURPOSE:
 *   'ok'       the component answered
 *   'skipped'  the component is NOT CONFIGURED here (no REDIS_URL, no
 *              NEO4J_URI, no storage connection string). Local dev and CI run
 *              without these, and "absent by configuration" must not read as
 *              "broken" — that would fail every CI health test and block
 *              nothing real. Production configures all of them, so nothing is
 *              skipped where it matters.
 *   'error'    configured and did not answer inside the timeout
 *
 * Overall ok = no 'error'. Error DETAIL is deliberately not exposed — this
 * endpoint is unauthenticated, and a connection string or hostname in an
 * error message would be a disclosure. The component name is enough for the
 * promote gate's log; the real diagnosis lives in the container logs.
 *
 * NOTE ON PROBE SEMANTICS: Container Apps' liveness/readiness probes hit
 * /api/ping, NOT this endpoint — deliberately. A Redis blip must not make the
 * platform restart API replicas; it must only stop a PROMOTION and fire an
 * alert. Do not point the ACA probes here.
 */

import { logger as rootLogger } from '../utils/logger';
import { semanticDb } from '../db/knex';
import { getRedisConnection } from '../jobs/redis';
import { getSession } from '../db/neo4j';
import { getTransformationQueue, getBusMatrixQueue } from '../jobs/queues';

const log = rootLogger.child({ mod: 'health' });

export type CheckStatus = 'ok' | 'error' | 'skipped';
export type HealthChecks = Record<string, CheckStatus>;

/** Per-component budget. A hung dependency must not hang the endpoint. */
const CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? 5000);

/** Race a probe against the budget. Any throw or timeout is 'error'. */
async function probe(name: string, fn: () => Promise<void>): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('health check timed out')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return 'ok';
  } catch (err) {
    log.warn({ err, component: name }, 'health check failed');
    return 'error';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkPostgres(): Promise<CheckStatus> {
  return probe('postgres', async () => {
    await semanticDb.raw('SELECT 1');
  });
}

async function checkRedis(): Promise<CheckStatus> {
  if (!process.env.REDIS_URL) return 'skipped';
  return probe('redis', async () => {
    const conn = getRedisConnection();
    if (!conn) throw new Error('redis connection unavailable');
    await conn.ping();
  });
}

async function checkNeo4j(): Promise<CheckStatus> {
  if (!process.env.NEO4J_URI) return 'skipped';
  return probe('neo4j', async () => {
    const session = getSession();
    try {
      await session.run('RETURN 1');
    } finally {
      await session.close().catch(() => {});
    }
  });
}

async function checkBlob(): Promise<CheckStatus> {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) return 'skipped';
  return probe('blob', async () => {
    // Dynamic on purpose (external package): local dev without Azure never
    // loads the SDK — the same deferral services/warehouse/container.ts makes.
    const { BlobServiceClient } = await import('@azure/storage-blob');
    const svc = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING!);
    await svc.getProperties();
  });
}

/**
 * Is anything LISTENING on this queue? getWorkers() asks Redis (CLIENT LIST),
 * so a dead jobs-worker shows up here even while its container reports
 * Running — the exact failure the P0-6 finding names. Without Redis there are
 * no queues to listen on (jobs run inline) and the check is 'skipped'.
 */
async function checkQueueWorkers(getQueue: () => { getWorkers: () => Promise<unknown[]> } | null): Promise<CheckStatus> {
  if (!process.env.REDIS_URL) return 'skipped';
  return probe('queue-workers', async () => {
    const queue = getQueue();
    if (!queue) throw new Error('queue unavailable');
    const workers = await queue.getWorkers();
    if (workers.length === 0) throw new Error('no worker is listening on the queue');
  });
}

export interface HealthProbes {
  postgres: () => Promise<CheckStatus>;
  redis: () => Promise<CheckStatus>;
  neo4j: () => Promise<CheckStatus>;
  blob: () => Promise<CheckStatus>;
  workerTransformation: () => Promise<CheckStatus>;
  workerBusMatrix: () => Promise<CheckStatus>;
}

const defaultProbes: HealthProbes = {
  postgres: checkPostgres,
  redis: checkRedis,
  neo4j: checkNeo4j,
  blob: checkBlob,
  workerTransformation: () => checkQueueWorkers(getTransformationQueue),
  workerBusMatrix: () => checkQueueWorkers(getBusMatrixQueue),
};

/** Pure verdict — exported so the tests can pin the skipped-is-not-broken rule. */
export function summarizeHealth(checks: HealthChecks): boolean {
  return Object.values(checks).every((v) => v === 'ok' || v === 'skipped');
}

/**
 * Run every component check in parallel. `overrides` exists for the tests —
 * production callers pass nothing.
 */
export async function runHealthChecks(overrides?: Partial<HealthProbes>): Promise<{ ok: boolean; checks: HealthChecks }> {
  const probes = { ...defaultProbes, ...overrides };
  const [postgres, redis, neo4j, blob, workerTransformation, workerBusMatrix] = await Promise.all([
    probes.postgres(),
    probes.redis(),
    probes.neo4j(),
    probes.blob(),
    probes.workerTransformation(),
    probes.workerBusMatrix(),
  ]);
  const checks: HealthChecks = {
    postgres,
    redis,
    neo4j,
    blob,
    worker_transformation: workerTransformation,
    worker_bus_matrix: workerBusMatrix,
  };
  return { ok: summarizeHealth(checks), checks };
}
