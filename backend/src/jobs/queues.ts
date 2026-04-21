/**
 * BullMQ queue definitions for all background jobs.
 *
 * Three queues:
 *   - schema-profiling: AI-powered schema analysis
 *   - ingestion: ETL data ingestion into Delta Lake
 *   - transformation: Star schema transformation runs
 *
 * If Redis is not available, queues are null and callers should
 * fall back to inline execution.
 */

import { Queue } from 'bullmq';
import { getRedisConnection } from './redis';

// ---------------------------------------------------------------------------
// Job data types
// ---------------------------------------------------------------------------

export interface SchemaProfilingJobData {
  connectionId: number;
  tenantId: number;
  triggeredBy: string; // user email
}

export interface IngestionJobData {
  connectionId: number;
  tenantId: number;
  tables: string[];     // table names to ingest
  triggeredBy: string;
}

export interface TransformationJobData {
  productId: number;
  tenantId: number;
  triggeredBy: string;
}

export interface EmailReportJobData {
  scheduleId: number;
  tenantId: number;
}

// ---------------------------------------------------------------------------
// Queue instances (null if Redis not configured)
// ---------------------------------------------------------------------------

let schemaProfilingQueue: Queue<SchemaProfilingJobData> | null = null;
let ingestionQueue: Queue<IngestionJobData> | null = null;
let transformationQueue: Queue<TransformationJobData> | null = null;
let emailReportQueue: Queue<EmailReportJobData> | null = null;

export function getSchemaProfilingQueue(): Queue<SchemaProfilingJobData> | null {
  if (schemaProfilingQueue) return schemaProfilingQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  schemaProfilingQueue = new Queue<SchemaProfilingJobData>('schema-profiling', { connection: conn });
  return schemaProfilingQueue;
}

export function getIngestionQueue(): Queue<IngestionJobData> | null {
  if (ingestionQueue) return ingestionQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  ingestionQueue = new Queue<IngestionJobData>('ingestion', { connection: conn });
  return ingestionQueue;
}

export function getTransformationQueue(): Queue<TransformationJobData> | null {
  if (transformationQueue) return transformationQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  transformationQueue = new Queue<TransformationJobData>('transformation', { connection: conn });
  return transformationQueue;
}

export function getEmailReportQueue(): Queue<EmailReportJobData> | null {
  if (emailReportQueue) return emailReportQueue;
  const conn = getRedisConnection();
  if (!conn) return null;
  emailReportQueue = new Queue<EmailReportJobData>('email-report', { connection: conn });
  return emailReportQueue;
}

/**
 * Close all queues gracefully.
 */
export async function closeQueues(): Promise<void> {
  await Promise.all([
    schemaProfilingQueue?.close(),
    ingestionQueue?.close(),
    transformationQueue?.close(),
    emailReportQueue?.close(),
  ]);
  schemaProfilingQueue = null;
  ingestionQueue = null;
  transformationQueue = null;
  emailReportQueue = null;
}
