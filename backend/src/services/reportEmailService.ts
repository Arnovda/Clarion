/**
 * Builds and sends a scheduled dashboard report email.
 *
 * Flow per schedule:
 *   1. Load dashboard spec + connection from DB.
 *   2. Execute all widget SQLs (reusing batch-execute logic, no HTTP hop).
 *   3. Optionally call Claude for a 3-4 sentence executive summary.
 *   4. Build HTML email with summary card + per-widget data tables.
 *   5. Send via emailService.
 */

import { semanticDb } from '../db/knex';
import { createConnector, createProductConnector } from '../connectors/ConnectorFactory';
import { sendEmail } from './emailService';
import { generateReportNarrative, formatAnswer } from '../ai/AIService';
import { getProductWarehousePath } from './productContext';
import { logger } from '../utils/logger';
import type { KpiResult } from '../ai/prompts/answerFormatterPrompt';

// HTML-escape any string that gets interpolated into the email body.
// Source data (widget rows, AI summary, user-supplied dashboard titles
// and column aliases) is untrusted from an email-rendering standpoint
// — even though most email clients sandbox HTML, we don't want to ship
// a vector that lets a tenant's data poison an email rendered by their
// own users. Cheap, defensive, never wrong.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Filter placeholder resolution (mirrors dashboards route helper)
// ---------------------------------------------------------------------------

function resolveFilters(sql: string, filterValues: Record<string, string>): string {
  let resolved = sql;
  for (const [key, value] of Object.entries(filterValues)) {
    const fallback = key.endsWith('_from') ? '1900-01-01' : key.endsWith('_to') ? '2099-12-31' : 'all';
    resolved = resolved.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || fallback);
  }
  // Clear any remaining placeholders with sensible defaults
  resolved = resolved
    .replace(/\{\{[^}]+_from\}\}/g, '1900-01-01')
    .replace(/\{\{[^}]+_to\}\}/g, '2099-12-31')
    .replace(/\{\{[^}]+\}\}/g, 'all');
  return resolved;
}

// ---------------------------------------------------------------------------
// HTML table builder for widget rows
// ---------------------------------------------------------------------------

function buildTable(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '<p style="color:#6b7280;font-size:13px">No data</p>';

  const cols = Object.keys(rows[0]);
  const headerCells = cols.map((c) => `<th style="padding:6px 12px;text-align:left;background:#f3f4f6;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;color:#374151">${escapeHtml(c)}</th>`).join('');
  const bodyRows = rows.slice(0, 20).map((row) => {
    const cells = cols.map((c) => {
      const v = row[c];
      const formatted = v == null ? '' : typeof v === 'number' ? v.toLocaleString() : String(v);
      return `<td style="padding:5px 12px;font-size:12px;color:#374151;border-bottom:1px solid #f3f4f6">${escapeHtml(formatted)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  const truncNote = rows.length > 20
    ? `<p style="font-size:11px;color:#9ca3af;margin:4px 12px 0">Showing 20 of ${rows.length} rows</p>`
    : '';

  return `<table style="width:100%;border-collapse:collapse;margin-top:8px"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>${truncNote}`;
}

// ---------------------------------------------------------------------------
// Full HTML email template
// ---------------------------------------------------------------------------

function buildHtmlEmail(
  dashboardTitle: string,
  summary: string | null,
  widgets: Array<{ title: string; rows: Record<string, unknown>[] | null; error?: string }>,
): string {
  const widgetSections = widgets.map(({ title, rows, error }) => {
    const body = error
      ? `<p style="color:#ef4444;font-size:13px">${escapeHtml(error)}</p>`
      : rows
        ? buildTable(rows)
        : '<p style="color:#6b7280;font-size:13px">No data</p>';

    return `
      <div style="margin-bottom:24px">
        <h3 style="margin:0 0 8px;font-size:13px;font-weight:600;color:#111827;text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(title)}</h3>
        ${body}
      </div>`;
  }).join('');

  const summarySection = summary ? `
    <div style="background:#eff6ff;border-left:3px solid #3b82f6;padding:16px 20px;margin-bottom:28px;border-radius:0 6px 6px 0">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#3b82f6;text-transform:uppercase;letter-spacing:0.08em">AI Summary</p>
      <p style="margin:0;font-size:14px;color:#1e40af;line-height:1.6">${escapeHtml(summary)}</p>
    </div>` : '';

  const now = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:680px;margin:32px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
    <!-- Header -->
    <div style="background:#111827;padding:24px 32px">
      <p style="margin:0 0 4px;font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.1em">Clarion Report · ${now}</p>
      <h1 style="margin:0;font-size:22px;font-weight:700;color:#ffffff">${escapeHtml(dashboardTitle)}</h1>
    </div>
    <!-- Body -->
    <div style="padding:28px 32px">
      ${summarySection}
      ${widgetSections}
    </div>
    <!-- Footer -->
    <div style="padding:16px 32px;border-top:1px solid #f3f4f6">
      <p style="margin:0;font-size:11px;color:#9ca3af">Sent automatically by Clarion. To manage this schedule, visit your dashboard settings.</p>
    </div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main export — called by the BullMQ email-report worker
// ---------------------------------------------------------------------------

export async function sendScheduledReport(scheduleId: number): Promise<void> {
  // 1. Load schedule + target (dashboard XOR saved question — migration 83)
  const schedule = await semanticDb('email_schedules').where({ id: scheduleId }).first();
  if (!schedule || !schedule.enabled) return;

  if (schedule.saved_question_id) {
    await sendScheduledQuestion(schedule);
    return;
  }

  const dashboard = await semanticDb('dashboards').where({ id: schedule.dashboard_id }).first();
  if (!dashboard) {
    logger.warn({ scheduleId }, '[report-email] Dashboard not found');
    return;
  }

  const spec = typeof dashboard.spec === 'string' ? JSON.parse(dashboard.spec) : dashboard.spec;
  if (!spec?.widgets?.length) {
    logger.warn({ scheduleId }, '[report-email] Dashboard spec has no widgets');
    return;
  }

  const recipients: string[] = Array.isArray(schedule.recipients)
    ? schedule.recipients
    : JSON.parse(schedule.recipients as string);

  if (!recipients.length) return;

  // 2. Resolve connection / product path and execute widget SQLs
  const connectionId: number = spec.connectionId ?? dashboard.connection_id;
  let connector: Awaited<ReturnType<typeof createProductConnector>>;

  // Detect product-layer dashboards (spec carries productId)
  if (spec.productId) {
    const product = await semanticDb('data_products').where({ id: spec.productId }).first();
    if (!product) {
      logger.warn({ scheduleId }, '[report-email] Product not found');
      return;
    }
    // NOTE: this call used to pass the whole product ROW (the signature
    // changed to `connectionId` in the 2026-05-05 rebuild and this caller
    // was never updated — hidden behind an untyped dynamic import). Pass
    // the connection id it actually expects, and fail legibly when the
    // warehouse has nothing materialised.
    const warehousePath = await getProductWarehousePath(product.connection_id as number);
    if (!warehousePath) {
      logger.warn({ scheduleId }, '[report-email] Product warehouse not materialised');
      return;
    }
    connector = await createProductConnector(warehousePath, product.connection_id as number);
  } else {
    const connection = await semanticDb('connections').where({ id: connectionId }).first();
    if (!connection) {
      logger.warn({ scheduleId }, '[report-email] Connection not found');
      return;
    }
    connector = await createConnector(connection);
  }

  await connector.connect();

  const widgetResults: Array<{ title: string; rows: Record<string, unknown>[] | null; error?: string }> = [];

  try {
    // Default filter values — use open ranges (schedules always run against "all time")
    const defaultFilters: Record<string, string> = {};
    for (const f of spec.filters ?? []) {
      if (f.type === 'date_range') {
        defaultFilters[`${f.id}_from`] = '';
        defaultFilters[`${f.id}_to`] = '';
      } else {
        defaultFilters[f.id] = 'all';
      }
    }

    await Promise.all(
      (spec.widgets as Array<{ id: string; type: string; title: string; sql: string }>).map(async (w) => {
        if (w.type === 'kpi_card') {
          // KPI cards rarely make useful email tables — include the value only
        }
        const resolvedSql = resolveFilters(w.sql, defaultFilters);
        try {
          const rows = (await connector.executeQuery(resolvedSql) as unknown) as Record<string, unknown>[];
          widgetResults.push({ title: w.title, rows });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          widgetResults.push({ title: w.title, rows: null, error: 'Could not load data' });
          logger.warn({ scheduleId, widget: w.id, err: msg }, '[report-email] Widget SQL error');
        }
      }),
    );
  } finally {
    connector.disconnect();
  }

  // 3. Optional AI summary — summarise widget results as KPI list
  let summary: string | null = null;
  if (schedule.ai_summary) {
    try {
      const kpiInputs: KpiResult[] = widgetResults
        .filter((w) => w.rows && w.rows.length > 0)
        .flatMap((w) => {
          const row = w.rows![0];
          return Object.entries(row).map(([key, val]) => ({
            kpi_name: `${w.title} — ${key}`,
            value: typeof val === 'number' ? val : String(val ?? ''),
            unit: '',
          }));
        })
        .slice(0, 12); // cap at 12 data points to avoid huge prompts

      if (kpiInputs.length > 0) {
        summary = await generateReportNarrative(
          dashboard.title as string,
          new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
          kpiInputs,
        );
      }
    } catch (err) {
      logger.warn({ scheduleId, err }, '[report-email] AI summary failed — sending without it');
    }
  }

  // 4. Build + send
  const html = buildHtmlEmail(dashboard.title as string, summary, widgetResults);
  await sendEmail({
    to: recipients,
    subject: `${dashboard.title} — Clarion Report`,
    html,
  });

  // 5. Update last_run_at
  await semanticDb('email_schedules')
    .where({ id: scheduleId })
    .update({ last_run_at: new Date(), updated_at: new Date() });

  logger.info({ scheduleId, recipients: recipients.length }, '[report-email] Sent');
}

// ---------------------------------------------------------------------------
// Saved-question schedules (Ask AI Release 3) — "email me this every Monday"
// from a chat answer. One stored, safety-checked SQL; a table + optional AI
// sentence. Deliberately reuses the same email chrome as dashboard reports.
// ---------------------------------------------------------------------------

async function sendScheduledQuestion(schedule: {
  id: number;
  saved_question_id: number;
  recipients: string[] | string;
  ai_summary: boolean;
}): Promise<void> {
  const sq = await semanticDb('saved_questions').where({ id: schedule.saved_question_id }).first();
  if (!sq) {
    logger.warn({ scheduleId: schedule.id }, '[report-email] Saved question not found');
    return;
  }
  const recipients: string[] = Array.isArray(schedule.recipients)
    ? schedule.recipients
    : JSON.parse(schedule.recipients as string);
  if (!recipients.length) return;

  const connection = await semanticDb('connections').where({ id: sq.connection_id }).first();
  if (!connection) {
    logger.warn({ scheduleId: schedule.id }, '[report-email] Connection not found');
    return;
  }

  let rows: Record<string, unknown>[] = [];
  let execError: string | undefined;
  try {
    let connector;
    if (sq.data_layer === 'product') {
      const warehousePath = await getProductWarehousePath(sq.connection_id);
      if (!warehousePath) throw new Error('product warehouse not materialised');
      connector = await createProductConnector(warehousePath, sq.connection_id as number, sq.tenant_id as number);
    } else {
      connector = await createConnector(connection);
    }
    await connector.connect();
    try {
      const result = await connector.executeQuery(sq.sql as string);
      rows = result.rows;
    } finally {
      connector.disconnect();
    }
  } catch (err) {
    execError = 'Could not load data';
    logger.warn({ scheduleId: schedule.id, err }, '[report-email] Saved question SQL error');
  }

  let summary: string | null = null;
  if (schedule.ai_summary && rows.length > 0) {
    try {
      summary = await formatAnswer(sq.question as string, rows);
    } catch (err) {
      logger.warn({ scheduleId: schedule.id, err }, '[report-email] answer summary failed — sending without it');
    }
  }

  const html = buildHtmlEmail(sq.question as string, summary, [
    { title: 'Result', rows: execError ? null : rows, error: execError },
  ]);
  await sendEmail({
    to: recipients,
    subject: `${sq.question} — Clarion`,
    html,
  });

  await semanticDb('email_schedules')
    .where({ id: schedule.id })
    .update({ last_run_at: new Date(), updated_at: new Date() });

  logger.info({ scheduleId: schedule.id, recipients: recipients.length }, '[report-email] Saved-question report sent');
}
