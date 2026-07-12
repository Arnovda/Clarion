/**
 * Application monitoring — Azure Application Insights integration.
 *
 * If APPLICATIONINSIGHTS_CONNECTION_STRING is set, initializes App Insights
 * for automatic request tracking, dependency tracking, and custom telemetry.
 *
 * If not set, all functions are no-ops (safe to call in development).
 *
 * IMPORTANT: This module must be imported BEFORE other modules so the
 * auto-instrumentation can patch HTTP, Express, and other libraries.
 */

import { logger as rootLogger } from './logger';

const log = rootLogger.child({ mod: 'monitoring' });

let appInsights: typeof import('applicationinsights') | null = null;

/**
 * Initialize Application Insights. Call this once at the very start of index.ts.
 */
export function initMonitoring(): void {
  const connString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connString) {
    log.info('Application Insights not configured — telemetry disabled');
    return;
  }

  try {
    // Dynamic import so the dependency is optional
    appInsights = require('applicationinsights');
    appInsights!
      .setup(connString)
      .setAutoDependencyCorrelation(true)
      .setAutoCollectRequests(true)
      .setAutoCollectPerformance(true, true)
      .setAutoCollectExceptions(true)
      .setAutoCollectDependencies(true)
      .setAutoCollectConsole(true, true)
      .setDistributedTracingMode(appInsights!.DistributedTracingModes.AI_AND_W3C)
      .setSendLiveMetrics(true)
      .start();

    log.info('Application Insights initialized');
  } catch (err) {
    log.warn({ err }, 'Failed to initialize Application Insights');
    appInsights = null;
  }
}

/**
 * Track a custom event (e.g., "query_executed", "schema_profiled").
 */
export function trackEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
  if (!appInsights) return;
  appInsights.defaultClient?.trackEvent({ name, properties, measurements });
}

/**
 * Track a custom metric (e.g., query latency, confidence score).
 */
export function trackMetric(name: string, value: number, properties?: Record<string, string>): void {
  if (!appInsights) return;
  appInsights.defaultClient?.trackMetric({ name, value, properties });
}

/**
 * Track an exception.
 */
export function trackException(error: Error, properties?: Record<string, string>): void {
  if (!appInsights) return;
  appInsights.defaultClient?.trackException({ exception: error, properties });
}

/**
 * Flush all pending telemetry (call before process exit).
 */
export async function flushTelemetry(): Promise<void> {
  if (!appInsights) return;
  try {
    appInsights.defaultClient?.flush();
  } catch {
    // Ignore flush errors during shutdown
  }
}
