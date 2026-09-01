/**
 * withHeartbeat (P1-1) — stamp liveness on a TIMER while work runs.
 *
 * The liveness-based reapers (services/reapers.ts) key on a heartbeat
 * column going quiet. Stamping only at phase boundaries would re-create
 * the false positive being removed: a schema profiling's Pass B is ONE
 * model call that can run for minutes on a large source, and a phase
 * boundary is exactly what does not happen while it runs. So the caller
 * that owns a long piece of work wraps it here — the stamp fires
 * immediately and then every `everyMs` regardless of what the work is
 * doing, and stops the moment the work settles. The process dying kills
 * the timer with it, which is the whole signal.
 *
 * Stamp failures are swallowed (a heartbeat that can fail its work is
 * worse than a missed beat — the reaper tolerates minutes of silence).
 */

import { logger } from '../utils/logger';

const log = logger.child({ component: 'heartbeat' });

export async function withHeartbeat<T>(
  stamp: () => Promise<unknown>,
  fn: () => Promise<T>,
  everyMs = 60_000,
): Promise<T> {
  const beat = () => stamp().catch((err) => log.debug({ err }, 'heartbeat stamp failed (non-fatal)'));
  await beat();
  const timer = setInterval(() => { void beat(); }, everyMs);
  // Never keep the process alive just to beat.
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
