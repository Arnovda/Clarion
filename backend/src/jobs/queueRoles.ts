/**
 * Which BullMQ queues this process should run.
 *
 * The split between the API container and the jobs-worker container is not
 * all-or-nothing, because the two processes do not have the same Azure
 * permissions. The deploy identity is only `Contributor`, which cannot create
 * role assignments, so a newly created worker app cannot be granted its own
 * managed identity. Anything that authenticates to Azure AD — starting a
 * sync-worker job execution, sending mail through Communication Services — must
 * therefore stay in the API container, which already has those grants.
 *
 * Everything that talks to storage with the connection string (the heavy DuckDB
 * transformations, warehouse maintenance) can move freely, and that is the work
 * actually worth isolating.
 *
 * `WORKER_QUEUES` — comma-separated queue names. Unset or empty means "run
 * everything", i.e. today's single-process behaviour, so local dev and any
 * deployment that hasn't split is unchanged.
 */

import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'queue-roles' });

/**
 * Queues that need no Azure AD identity — safe to run anywhere. These are the
 * ones that make the split worth doing: transformations are the heaviest
 * workload on the platform and today they compete with every dashboard query.
 */
export const COMPUTE_QUEUES = [
  'transformation',
  'scheduled-transformation',
  'warehouse-maintenance',
  'security-maintenance',
] as const;

/**
 * Queues that authenticate to Azure AD via the container's managed identity and
 * so must run where those role assignments exist (the API container today).
 *   • bus-matrix / pipeline-schedule / connection-sync-schedule → start
 *     sync-worker job executions through ARM
 *   • email-report / morning-brief → send through Communication Services
 */
export const IDENTITY_QUEUES = [
  'bus-matrix',
  'connection-sync-schedule',
  'pipeline-schedule',
  'email-report',
  'morning-brief',
] as const;

let logged = false;

function selected(): Set<string> | null {
  const raw = (process.env.WORKER_QUEUES ?? '').trim();
  if (!raw) return null;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Whether a worker for `queueName` should be started in this process. */
export function shouldRunQueue(queueName: string): boolean {
  const set = selected();
  if (!set) {
    if (!logged) {
      logged = true;
      log.info('WORKER_QUEUES not set — running every queue in this process');
    }
    return true;
  }
  if (!logged) {
    logged = true;
    log.info({ queues: [...set] }, 'WORKER_QUEUES set — running only these queues');
  }
  return set.has(queueName);
}
