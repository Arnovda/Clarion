/**
 * Shared Redis (IORedis) connection for BullMQ queues and workers.
 *
 * If REDIS_URL is not set, BullMQ features are disabled and all
 * queue operations fall back to inline execution (same as before).
 */

import IORedis from 'ioredis';

let _connection: IORedis | null = null;

export function getRedisConnection(): IORedis | null {
  if (_connection) return _connection;

  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[jobs] REDIS_URL not set — job queues disabled, using inline execution');
    return null;
  }

  _connection = new IORedis(url, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
  });

  _connection.on('error', (err) => {
    console.error('[jobs] Redis connection error:', err.message);
  });

  _connection.on('connect', () => {
    console.log('[jobs] Redis connected');
  });

  return _connection;
}

export async function closeRedis(): Promise<void> {
  if (_connection) {
    await _connection.quit();
    _connection = null;
  }
}
