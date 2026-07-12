/**
 * Shared Redis (IORedis) connection for BullMQ queues and workers.
 *
 * If REDIS_URL is not set, BullMQ features are disabled and all
 * queue operations fall back to inline execution (same as before).
 */

import IORedis from 'ioredis';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'redis' });

let _connection: IORedis | null = null;

export function getRedisConnection(): IORedis | null {
  if (_connection) return _connection;

  const url = process.env.REDIS_URL;
  if (!url) {
    log.info('REDIS_URL not set — job queues disabled, using inline execution');
    return null;
  }

  _connection = new IORedis(url, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
  });

  _connection.on('error', (err) => {
    log.error({ err }, 'Redis connection error');
  });

  _connection.on('connect', () => {
    log.info('Redis connected');
  });

  return _connection;
}

export async function closeRedis(): Promise<void> {
  if (_connection) {
    await _connection.quit();
    _connection = null;
  }
}
