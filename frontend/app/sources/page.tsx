'use client';

import { useState, useEffect, Suspense, Fragment } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import RequireRole from '@/components/RequireRole';
import { connectorMark } from '@/lib/connectorIcons';
import IngestionWizard from '@/components/IngestionWizard';
import api from '@/lib/api';
import { getToken } from '@/lib/auth';
import { streamSSE, SSEHttpError } from '@/lib/sse';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyncSchedule {
  id: number;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
  next_run: string | null;
}

interface SyncRunRow {
  id: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  triggered_by_user_id: number | null;
  row_counts: Record<string, number> | string | null;
  warnings: string[] | string | null;
  error_message: string | null;
}

interface Connection {
  id: number;
  name: string;
  type: string;
  config: Record<string, string> | string;
  domains?: string[];
  created_by: string;
  created_at: string;
  query_engine?: string;          // 'source' | 'duckdb'
  ingestion_status?: string;      // null | 'pending' | 'running' | 'done' | 'error'
  last_ingested_at?: string;
  // Source-connector fields (populated when this connection was created via /sources/add-source).
  connector_type?: string | null; // e.g. 'exactonline'
  selected_entities?: string[];
  last_synced_at?: string | null;
  last_sync_status?: string | null; // 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  // Profiling progress fields — used by SourceCard to recover state across
  // tab switches / page reloads when profiling is still running.
  profiling_status?: string | null;   // 'running' | 'structural' | 'done' | 'error' | null
  profiling_phase?: string | null;
  profiling_message?: string | null;
  profiling_progress?: number | null;
}

interface Connector {
  id: string;
  name: string;
  description: string;
  available: boolean;
  color: string;
  iconLetter: string;
  formFields: FormField[];
}

interface FormField {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'password' | 'number';
  hint?: string;
}

// ---------------------------------------------------------------------------
// Connector catalog
// ---------------------------------------------------------------------------

const CONNECTORS: Connector[] = [
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Local .db file on this machine',
    available: true,
    color: 'bg-blue-500',
    iconLetter: 'S',
    formFields: [
      {
        key: 'filepath',
        label: 'File path',
        placeholder: 'C:\\Users\\you\\Documents\\clarion\\data\\sample.db',
        type: 'text',
        hint: 'Absolute path to your .db file on this machine.',
      },
    ],
  },
  {
    id: 'sqlserver',
    name: 'SQL Server',
    description: 'Microsoft SQL Server / Azure SQL',
    available: true,
    color: 'bg-red-500',
    iconLetter: 'M',
    formFields: [
      { key: 'host', label: 'Server', placeholder: 'localhost or myserver.database.windows.net', type: 'text' },
      { key: 'port', label: 'Port', placeholder: '1433', type: 'number' },
      { key: 'database', label: 'Database', placeholder: 'AdventureWorks', type: 'text' },
      { key: 'user', label: 'Username', placeholder: 'sa', type: 'text' },
      { key: 'password', label: 'Password', placeholder: '••••••••', type: 'password' },
      { key: 'encrypt', label: 'Encrypt connection', placeholder: 'true', type: 'text', hint: 'Required for Azure SQL. Enter true or false.' },
      { key: 'trustServerCertificate', label: 'Trust server certificate', placeholder: 'false', type: 'text', hint: 'Set true for local dev with self-signed certs.' },
      { key: 'schema', label: 'Schema', placeholder: 'dbo', type: 'text', hint: 'Leave empty for default (dbo).' },
    ],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'PostgreSQL database',
    available: true,
    color: 'bg-indigo-500',
    iconLetter: 'P',
    formFields: [
      { key: 'host', label: 'Host', placeholder: 'localhost or db.example.com', type: 'text' },
      { key: 'port', label: 'Port', placeholder: '5432', type: 'number' },
      { key: 'database', label: 'Database', placeholder: 'mydb', type: 'text' },
      { key: 'user', label: 'Username', placeholder: 'postgres', type: 'text' },
      { key: 'password', label: 'Password', placeholder: '••••••••', type: 'password' },
      { key: 'ssl', label: 'SSL', placeholder: 'false', type: 'text', hint: 'Enter true for SSL connections.' },
      { key: 'schema', label: 'Schema', placeholder: 'public', type: 'text', hint: 'Leave empty for default (public).' },
    ],
  },
  {
    id: 'mysql',
    name: 'MySQL',
    description: 'MySQL or MariaDB database',
    available: true,
    color: 'bg-orange-500',
    iconLetter: 'M',
    formFields: [
      { key: 'host', label: 'Host', placeholder: 'localhost or db.example.com', type: 'text' },
      { key: 'port', label: 'Port', placeholder: '3306', type: 'number' },
      { key: 'database', label: 'Database', placeholder: 'mydb', type: 'text' },
      { key: 'user', label: 'Username', placeholder: 'root', type: 'text' },
      { key: 'password', label: 'Password', placeholder: '••••••••', type: 'password' },
      { key: 'ssl', label: 'SSL', placeholder: 'false', type: 'text', hint: 'Enter true for SSL connections.' },
    ],
  },
  // NOTE: Exact Online, Odoo, Excel and SharePoint are REGISTRY connectors
  // (packages/connectors/src/*). Their tiles come from the /source-types fetch
  // below, so they must not be listed here — a hardcoded "coming soon" Exact
  // Online entry sat in this list long after the connector shipped, and the
  // page drew it twice: once greyed out, once live. `STATIC_CONNECTORS` filters
  // that collision out now, but the real rule is that a connector belongs in
  // exactly one of the two lists.
  {
    id: 'salesforce',
    name: 'Salesforce',
    description: 'CRM & cloud platform',
    available: false,
    color: 'bg-sky-500',
    iconLetter: 'S',
    formFields: [],
  },
  {
    id: 'googlesheets',
    name: 'Google Sheets',
    description: 'Spreadsheet data source',
    available: false,
    color: 'bg-green-500',
    iconLetter: 'G',
    formFields: [],
  },
];

// ---------------------------------------------------------------------------
// Registry connector presentation (visual hints — UX only, not functional)
// ---------------------------------------------------------------------------
// Backend's /api/source-types returns each connector's `displayName` and
// optional `iconSvg`. These maps add tile-level UX polish (colour + a richer
// description than the connector wants to bake into its package). Add an
// entry per registry connector you want curated styling for; unknown types
// fall back to amber + a generic description.

const REGISTRY_DESCRIPTIONS: Record<string, string> = {
  exactonline: 'Sync GL, sales and master data from Exact Online.',
  odoo: 'Sync accounting, sales and inventory from Odoo (ERP & CRM).',
  excel: 'Upload a spreadsheet — budgets, mappings, anything you keep in Excel.',
  sharepoint: 'Read spreadsheets straight from a SharePoint or OneDrive library.',
};

const REGISTRY_COLORS: Record<string, string> = {
  exactonline: 'bg-orange-500',
  odoo: 'bg-purple-500',
  excel: 'bg-emerald-600',
  sharepoint: 'bg-sky-600',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConfig(conn: Connection): Record<string, string> {
  if (typeof conn.config === 'string') {
    try { return JSON.parse(conn.config); } catch { return {}; }
  }
  return (conn.config as Record<string, string>) ?? {};
}

/**
 * The product's own name for a connector id, used where only the id is to
 * hand. Registry tiles carry their `displayName` from the backend; a connection
 * row does not, and printing its storage engine ("DUCKDB") told the user
 * nothing about what they connected.
 */
const CONNECTOR_LABELS: Record<string, string> = {
  exactonline: 'Exact Online',
  odoo: 'Odoo',
  excel: 'Excel',
  sharepoint: 'SharePoint',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  sqlserver: 'SQL Server',
  sqlite: 'SQLite',
};

function connectorLabel(id: string): string | undefined {
  return CONNECTOR_LABELS[id];
}

function connectorForType(type: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === type);
}

// ---------------------------------------------------------------------------
// ConnectorIcon
// ---------------------------------------------------------------------------

function ConnectorIcon({ connector, size = 'md' }: { connector: Connector; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'w-8 h-8 text-sm', md: 'w-10 h-10 text-base', lg: 'w-12 h-12 text-lg' };
  const glyphs = { sm: 'w-4 h-4', md: 'w-5 h-5', lg: 'w-6 h-6' };
  const mark = connectorMark(connector.id);

  // The product's own mark on a wash of its own colour. Recognised before the
  // label is read, and quiet enough that ten of them in a grid do not shout.
  if (mark) {
    return (
      <div
        className={`${sizes[size]} rounded-lg flex items-center justify-center shrink-0 border`}
        style={{ backgroundColor: `${mark.color}14`, borderColor: `${mark.color}2E` }}
      >
        <svg viewBox={mark.viewBox} className={glyphs[size]} fill={mark.color} aria-hidden="true">
          {mark.art}
        </svg>
      </div>
    );
  }

  // No mark for this connector yet — the initial on its colour, as before.
  return (
    <div className={`${sizes[size]} ${connector.color} rounded-lg flex items-center justify-center text-white font-bold shrink-0`}>
      {connector.iconLetter}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConnectionCard
// ---------------------------------------------------------------------------

// TryAskingCallout removed 2026-05-12 — /sources is a curation surface,
// not a query launchpad. Asking lives on /ask. Component + supporting
// constants deleted; if we want a similar handoff later, it should live
// inside the "Sync complete" toast or on /home where it belongs.

// ────────────────────────────────────────────────────────────────────────────
// SchemaChangesPanel — renders recent schema-drift detections for one
// connection, with the per-table additions/removals/type changes the
// SyncOrchestrator captured at detection time. Lazy-loaded; renders
// nothing if there are no recorded changes (keeps cards uncluttered for
// connections with stable schemas).
//
// Auto-fetches on mount whenever `connId` is set; the parent only
// passes it in when the user landed here from a notification (i.e. the
// URL carries `?connectionId=N`). Other cards skip the fetch entirely.
// ────────────────────────────────────────────────────────────────────────────

interface SchemaChange {
  id: number;
  detected_at: string;
  summary: string;
  diff: {
    added_tables:   Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
    removed_tables: Array<{ name: string }>;
    changed_tables: Array<{
      name: string;
      added_columns:   Array<{ name: string; type: string }>;
      removed_columns: Array<{ name: string; type: string }>;
      changed_columns: Array<{ name: string; old_type: string; new_type: string }>;
    }>;
  };
  tables_added: number;
  tables_removed: number;
  columns_added: number;
  columns_removed: number;
  columns_changed: number;
}

function SchemaChangesPanel({
  connId, highlightedChangeId, onReProfile, reprofiling,
}: {
  connId: number;
  highlightedChangeId?: number;
  onReProfile: () => void;
  reprofiling: boolean;
}) {
  const [changes, setChanges] = useState<SchemaChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set(highlightedChangeId ? [highlightedChangeId] : []));

  useEffect(() => {
    let cancelled = false;
    api.get(`/connections/${connId}/schema-changes?limit=10`)
      .then((res) => {
        if (cancelled) return;
        setChanges(res.data?.data ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'Failed to load schema changes';
        setError(msg);
      });
    return () => { cancelled = true; };
  }, [connId]);

  // Loading state and hard errors stay invisible — the card layout
  // shouldn't twitch while we're fetching.
  if (error) return null;
  if (changes === null) return null;

  // Empty state is reached when the user landed from a notification
  // (parent only mounts this panel when `?connectionId` matches) but
  // we have no captured diff. Two common reasons:
  //   1. The notification was fired BEFORE the schema-diff capture
  //      shipped (older syncs don't have rows in `schema_changes`).
  //   2. The diff write itself failed at the time (rare — code is
  //      wrapped in try/catch so notification still fires generically).
  // Either way the user came looking for "what changed" and deserves
  // an answer, not silence. Re-analyse refreshes AI descriptions
  // against the current live schema regardless.
  if (changes.length === 0) {
    return (
      <div className="mt-2 px-3 py-2.5 rounded-md border border-line bg-softer">
        <div className="flex items-start gap-2">
          <span className="text-muted-2 mt-0.5">ℹ</span>
          <div className="flex-1 min-w-0">
            <p className="text-[12.5px] text-ink-2 leading-snug">
              No schema-change details recorded for this source yet.
            </p>
            <p className="text-[11px] text-muted-2 mt-1 leading-relaxed">
              Older notifications didn&apos;t capture per-column diffs. The next sync
              that detects drift will record the changes here. Re-analyse to refresh
              AI descriptions against the current schema.
            </p>
            <button
              onClick={onReProfile}
              disabled={reprofiling}
              className="mt-2 text-[10.5px] font-mono uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover disabled:opacity-50 transition-colors"
            >
              {reprofiling ? 'Re-analysing…' : 'Re-analyse now →'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="mt-2 px-3 py-2.5 rounded-md border border-line bg-warn-soft">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-warn">⚠</span>
          <p className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-2 font-medium">
            {changes.length} schema change{changes.length === 1 ? '' : 's'} detected
          </p>
        </div>
        <button
          onClick={onReProfile}
          disabled={reprofiling}
          className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover disabled:opacity-50 transition-colors"
        >
          {reprofiling ? 'Re-analysing…' : 'Re-analyse now'}
        </button>
      </div>
      <ul className="space-y-1.5">
        {changes.map((c) => {
          const open = expanded.has(c.id);
          return (
            <li key={c.id} className="border-t border-line first:border-t-0 pt-1.5 first:pt-0">
              <button
                onClick={() => toggle(c.id)}
                className="w-full text-left flex items-start gap-2 hover:bg-warn-soft/60 rounded transition-colors"
              >
                <span className="text-[10px] mt-0.5 text-muted-2 flex-shrink-0">{open ? '▾' : '▸'}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[12.5px] text-ink leading-snug">{c.summary}</p>
                  <p className="text-[10.5px] font-mono uppercase tracking-[0.06em] text-muted-2">
                    {new Date(c.detected_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                  </p>
                </div>
              </button>
              {open && <SchemaDiffDetail diff={c.diff} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SchemaDiffDetail({ diff }: { diff: SchemaChange['diff'] }) {
  return (
    <div className="ml-4 mt-2 space-y-2 text-[11.5px]">
      {diff.added_tables.length > 0 && (
        <div>
          <p className="text-[10px] font-mono uppercase tracking-[0.08em] text-ok mb-1">+ Tables added</p>
          <ul className="space-y-0.5 pl-2">
            {diff.added_tables.map((t) => (
              <li key={t.name} className="text-ink-2">
                <span className="font-mono">{t.name}</span>{' '}
                <span className="text-muted-2">({t.columns.length} columns)</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {diff.removed_tables.length > 0 && (
        <div>
          <p className="text-[10px] font-mono uppercase tracking-[0.08em] text-rose-700 mb-1">− Tables removed</p>
          <ul className="space-y-0.5 pl-2">
            {diff.removed_tables.map((t) => (
              <li key={t.name} className="font-mono text-ink-2">{t.name}</li>
            ))}
          </ul>
        </div>
      )}
      {diff.changed_tables.length > 0 && (
        <div>
          <p className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted mb-1">~ Tables changed</p>
          <ul className="space-y-1.5 pl-2">
            {diff.changed_tables.map((t) => (
              <li key={t.name}>
                <p className="font-mono text-ink-2">{t.name}</p>
                {t.added_columns.length > 0 && (
                  <p className="pl-3 text-ok">
                    +{' '}
                    {t.added_columns.map((c) => (
                      <span key={c.name} className="font-mono mr-2">{c.name}<span className="text-muted-2 ml-0.5">:{c.type}</span></span>
                    ))}
                  </p>
                )}
                {t.removed_columns.length > 0 && (
                  <p className="pl-3 text-rose-700">
                    −{' '}
                    {t.removed_columns.map((c) => (
                      <span key={c.name} className="font-mono mr-2">{c.name}</span>
                    ))}
                  </p>
                )}
                {t.changed_columns.length > 0 && (
                  <ul className="pl-3 text-muted">
                    {t.changed_columns.map((c) => (
                      <li key={c.name} className="font-mono">
                        ~ {c.name}: <span className="text-rose-700">{c.old_type}</span>{' '}
                        <span className="text-muted-2">→</span>{' '}
                        <span className="text-ok">{c.new_type}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ConnectionCard({
  conn,
  onDelete,
  onStartReProfile,
  onReProfileDone,
  onEdit,
  onReIngest,
  highlightedFromUrl,
  highlightedSchemaChangeId,
}: {
  conn: Connection;
  onDelete: (id: number) => void;
  onStartReProfile: (id: number) => void;
  onReProfileDone: (id: number) => void;
  onEdit: (conn: Connection) => void;
  onReIngest: (conn: Connection) => void;
  /** True when this card matches `?connectionId=` on the URL — typically
   *  set by clicking a schema-drift notification. Used to auto-fetch
   *  the schema-changes panel on mount. */
  highlightedFromUrl?: boolean;
  /** Auto-expand this specific schema_changes row (from `?schemaChange=`).
   *  Only meaningful when highlightedFromUrl is true. */
  highlightedSchemaChangeId?: number;
}) {
  const router = useRouter();
  const connector = connectorForType(conn.type);
  const config = getConfig(conn);
  const [deleting, setDeleting] = useState(false);
  const [reprofiling, setReprofiling] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const isSourceConnector = !!conn.connector_type;
  const [syncing, setSyncing] = useState(conn.last_sync_status === 'running' || conn.last_sync_status === 'queued');
  const [syncStatus, setSyncStatus] = useState<string | null>(conn.last_sync_status ?? null);
  const [syncRowCounts, setSyncRowCounts] = useState<Record<string, number> | null>(null);
  const [syncRunId, setSyncRunId] = useState<number | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  // Profiling phase — orchestrator triggers profiling automatically after a
  // successful sync, but until now that ran silently. We poll the connection
  // row once the sync is done so the card can show "Analysing…" and switch
  // to "Ready" only when source_tables / source_columns are populated.
  //
  // Seed from the connection row so progress survives a tab switch / page
  // reload — the backend has `profiling_status` + `profiling_message` +
  // `profiling_progress` columns that the worker updates as it runs.
  const [profilingState, setProfilingState] = useState<{
    status: string | null;
    message: string | null;
    progress: number | null;
  }>({
    status: conn.profiling_status ?? null,
    message: conn.profiling_message ?? null,
    progress: typeof conn.profiling_progress === 'number' ? conn.profiling_progress : null,
  });
  const [profilingPolling, setProfilingPolling] = useState(conn.profiling_status === 'running');
  // Sync history panel — collapsed by default; loaded lazily on expand.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<SyncRunRow[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  // Schedule panel — same lazy-load + collapsed pattern.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [schedule, setSchedule] = useState<SyncSchedule | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [cronDraft, setCronDraft] = useState('0 6 * * *');           // 06:00 daily by default
  const [tzDraft, setTzDraft] = useState('Europe/Brussels');
  const [enabledDraft, setEnabledDraft] = useState(true);

  // Recover the active syncRunId on mount when the card lands already in
  // a `syncing` state. Without this, switching browser tabs (or any
  // remount) loses the in-memory syncRunId set by handleSyncNow, the
  // polling effect below short-circuits on `syncRunId === null`, and the
  // user sees no progress until the page is reloaded. The latest row in
  // source_sync_runs for this connection is authoritative — if it's still
  // running/queued, pick it up; if it's already terminal, reconcile state.
  useEffect(() => {
    if (!syncing || syncRunId !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get(`/connections/${conn.id}/sync-runs?limit=1`);
        const latest = (res.data?.data ?? [])[0];
        if (!latest || cancelled) return;
        if (latest.status === 'running' || latest.status === 'queued') {
          setSyncRunId(latest.id);
          setSyncStatus(latest.status);
          if (latest.row_counts) {
            setSyncRowCounts(typeof latest.row_counts === 'string' ? JSON.parse(latest.row_counts) : latest.row_counts);
          }
        } else {
          // Terminal — reconcile so the card doesn't sit stuck on "Syncing…".
          setSyncing(false);
          setSyncStatus(latest.status);
          if (latest.row_counts) {
            setSyncRowCounts(typeof latest.row_counts === 'string' ? JSON.parse(latest.row_counts) : latest.row_counts);
          }
          if (latest.status === 'failed') setSyncError(latest.error_message ?? 'Sync failed');
          if (latest.status === 'succeeded') setProfilingPolling(true);
        }
      } catch {
        // ignore — user can refresh
      }
    })();
    return () => { cancelled = true; };
  }, [syncing, syncRunId, conn.id]);

  // Live-poll the active sync run while it's running.
  useEffect(() => {
    if (!syncing || syncRunId === null) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await api.get(`/connections/${conn.id}/sync-runs/${syncRunId}`);
        const row = res.data?.data;
        if (!row || stopped) return;
        setSyncStatus(row.status);
        if (row.row_counts) {
          setSyncRowCounts(typeof row.row_counts === 'string' ? JSON.parse(row.row_counts) : row.row_counts);
        }
        if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled') {
          setSyncing(false);
          if (row.status === 'failed') setSyncError(row.error_message ?? 'Sync failed');
          // Sync done → start polling profiling state. Only chase profiling
          // when the sync actually succeeded — failed/cancelled syncs don't
          // trigger profiling on the backend.
          if (row.status === 'succeeded') setProfilingPolling(true);
        }
      } catch {
        // ignore; next tick will retry
      }
    };
    void tick();
    const interval = setInterval(tick, 2000);
    return () => { stopped = true; clearInterval(interval); };
  }, [syncing, syncRunId, conn.id]);

  // After sync succeeds, poll the connection row's profiling fields. Stop
  // when status reaches a terminal state ('done' or 'error') or after
  // ~10 minutes (safety cap — profiler shouldn't take that long).
  useEffect(() => {
    if (!profilingPolling) return;
    let stopped = false;
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const res = await api.get('/connections');
        const updated = (res.data?.data ?? []).find((c: { id: number }) => c.id === conn.id);
        if (!updated || stopped) return;
        setProfilingState({
          status: updated.profiling_status ?? null,
          message: updated.profiling_message ?? null,
          progress: typeof updated.profiling_progress === 'number' ? updated.profiling_progress : null,
        });
        const terminal =
          updated.profiling_status === 'done' ||
          updated.profiling_status === 'error' ||
          updated.profiling_status === 'structural';
        if (terminal || Date.now() - startedAt > 10 * 60_000) {
          setProfilingPolling(false);
        }
      } catch {
        // ignore; next tick retries
      }
    };
    void tick();
    const interval = setInterval(tick, 2500);
    return () => { stopped = true; clearInterval(interval); };
  }, [profilingPolling, conn.id]);

  async function handleSyncNow() {
    setSyncError(null);
    setSyncRowCounts(null);
    setSyncing(true);
    setSyncStatus('queued');
    try {
      const res = await api.post(`/connections/${conn.id}/sync`);
      const data = res.data?.data;
      if (data?.syncRunId) setSyncRunId(data.syncRunId);
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })
        ?.response?.data?.error
        ?? (err as Error)?.message
        ?? 'Sync failed to start';
      setSyncError(msg);
      setSyncing(false);
      setSyncStatus('failed');
    }
  }

  async function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && history === null) {
      setHistoryLoading(true);
      try {
        const res = await api.get(`/connections/${conn.id}/sync-runs?limit=20`);
        setHistory(res.data?.data ?? []);
      } catch {
        setHistory([]);
      } finally {
        setHistoryLoading(false);
      }
    }
  }

  async function toggleSchedule() {
    const next = !scheduleOpen;
    setScheduleOpen(next);
    setScheduleError(null);
    if (next && schedule === null) {
      setScheduleLoading(true);
      try {
        const res = await api.get(`/connections/${conn.id}/sync-schedule`);
        const s = res.data?.data as SyncSchedule | null;
        setSchedule(s);
        if (s) {
          setCronDraft(s.cron_expression);
          setTzDraft(s.timezone);
          setEnabledDraft(s.enabled);
        }
      } catch {
        setSchedule(null);
      } finally {
        setScheduleLoading(false);
      }
    }
  }

  async function saveSchedule() {
    setScheduleSaving(true);
    setScheduleError(null);
    try {
      const res = await api.put(`/connections/${conn.id}/sync-schedule`, {
        cronExpression: cronDraft.trim(),
        timezone: tzDraft.trim() || 'UTC',
        enabled: enabledDraft,
      });
      setSchedule(res.data?.data ?? null);
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })
        ?.response?.data?.error
        ?? (err as Error)?.message
        ?? 'Failed to save schedule';
      setScheduleError(msg);
    } finally {
      setScheduleSaving(false);
    }
  }

  async function removeSchedule() {
    if (!schedule) return;
    if (!confirm('Remove the scheduled sync?')) return;
    setScheduleSaving(true);
    try {
      await api.delete(`/connections/${conn.id}/sync-schedule`);
      setSchedule(null);
    } catch {
      // ignore — UI shows the still-present schedule until they retry
    } finally {
      setScheduleSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Remove connection "${conn.name}"? This will also delete all definitions.`)) return;
    setDeleting(true);
    try {
      await api.delete(`/connections/${conn.id}`);
      onDelete(conn.id);
    } catch {
      alert('Failed to delete connection.');
    } finally {
      setDeleting(false);
    }
  }

  function handleReProfile() {
    setReprofiling(true);
    onStartReProfile(conn.id);
    // The ProfilingBanner handles the SSE stream — no direct API call needed here
  }

  // Opt-in AI enrichment of vendor descriptions (admin-only route). Dry-run
  // first so the user sees scope before any tokens are spent; results land
  // as drafts in the AI review queue.
  async function handleEnrich() {
    try {
      setEnriching(true);
      const dry = await api.post(`/connections/${conn.id}/enrich-descriptions?dryRun=1`);
      const count = dry.data?.data?.candidates ?? 0;
      if (count === 0) {
        alert('No columns are eligible for enrichment yet. Eligible = vendor-documented measures and relationship columns that you haven\'t hand-edited. Run Analyse first if you haven\'t.');
        return;
      }
      if (!window.confirm(
        `Enrich ${count} vendor-documented column(s) with AI-observed data context?\n\n` +
        'This spends AI tokens (typically well under a euro) and can take a minute or two. ' +
        'The vendor text is kept as the base; enriched versions appear in the AI review queue for approval.',
      )) return;
      const res = await api.post(`/connections/${conn.id}/enrich-descriptions`);
      const d = res.data?.data;
      alert(`Enriched ${d?.enriched ?? 0} of ${d?.candidates ?? 0} column(s) across ${d?.tables ?? 0} table(s). Review them in the AI review queue.`);
    } catch {
      alert('Enrichment failed — see backend logs.');
    } finally {
      setEnriching(false);
    }
  }

  // ── Derive a single status pill + a contextual "next step" hint from the
  //    union of sync + profiling state. Status-first design: the card's
  //    most prominent piece of metadata is "what state is this in?" — not
  //    "what kind of connection?". The hint sits underneath and tells the
  //    user what to do next without them needing to read every button.
  const status: { label: string; tone: 'ok' | 'ai' | 'warn' | 'err' | 'idle' } = (() => {
    if (syncError || profilingState.status === 'error') return { label: 'Needs attention', tone: 'err' };
    if (syncing)                                          return { label: 'Syncing',         tone: 'ai'  };
    if (profilingState.status === 'running')              return { label: 'Analysing',       tone: 'ai'  };
    if (profilingState.status === 'done')                 return { label: 'Ready',           tone: 'ok'  };
    // Synced but not yet AI-analysed ('structural' = tables registered in
    // the catalog post-sync, or a pre-feature sync with no profile at all).
    // Deliberately NOT "Ready" — the AI layer hasn't run, and calling it
    // Ready hid the remaining step from users.
    if (isSourceConnector && conn.last_synced_at)         return { label: 'Synced',          tone: 'ok'  };
    if (isSourceConnector)                                return { label: 'Not synced',      tone: 'idle' };
    if (conn.last_ingested_at)                            return { label: 'Ready',           tone: 'ok'  };
    return { label: 'Idle', tone: 'idle' };
  })();
  const statusToneClass = {
    ok:   'bg-ok-soft text-ok',
    ai:   'bg-ai-soft text-ai',
    warn: 'bg-warn-soft text-warn',
    err:  'bg-err-soft text-err',
    idle: 'bg-softer text-muted-2',
  }[status.tone];
  const nextStep: React.ReactNode | null = (() => {
    if (syncError)                              return 'Sync failed — review the error and try again.';
    if (profilingState.status === 'error')      return 'Analysis failed — try Re-analyse to retry.';
    if (syncing || profilingState.status === 'running') return null;
    if (isSourceConnector && !conn.last_synced_at) return 'Click Sync now to pull data into Clarion.';
    if (profilingState.status === 'structural')
      return 'Tables are loaded and visible in the catalog. Click Analyse to add AI descriptions and relationships.';
    if (profilingState.status !== 'done' && isSourceConnector && conn.last_synced_at)
      return 'Data is in. Click Analyse to register and describe the tables in the catalog.';
    // Analysed — the next step in the journey lives on Build, not here:
    // turning sources into topics is a tenant-level act (shared data spans
    // sources), so this card only points at it.
    return <>Analysed. <a href="/build" className="text-ocean hover:underline">Turn it into topics on Build →</a></>;
  })();

  return (
    <div className="bg-raised border border-line rounded-lg p-5 flex items-start gap-4 hover:border-line-strong transition-colors">
      {connector ? (
        <ConnectorIcon connector={connector} size="lg" />
      ) : (
        <div
          className="w-12 h-12 rounded-md flex items-center justify-center text-white text-[18px] font-semibold shrink-0 bg-ocean"
          title={conn.type}
        >
          {conn.name.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-[14px] font-medium text-ink">{conn.name}</span>
          <span className={`px-2 py-0.5 rounded border border-line text-[10px] font-mono tracking-[0.08em] uppercase ${statusToneClass}`}>
            {status.label}
          </span>
        </div>
        <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted-2 mb-1">{conn.type}</p>
        {config.filepath && (
          <p className="text-[11px] text-ink-3 font-mono truncate" title={config.filepath}>{config.filepath}</p>
        )}
        {!!(config as Record<string, unknown>).host && (
          <p className="text-[11px] text-ink-3 font-mono truncate">
            {String((config as Record<string, unknown>).host)}:{String((config as Record<string, unknown>).port ?? '')}
            {(config as Record<string, unknown>).database ? ` / ${String((config as Record<string, unknown>).database)}` : ''}
          </p>
        )}
        {(() => {
          const tags: string[] = Array.isArray(conn.domains)
            ? conn.domains
            : (() => { try { return JSON.parse(conn.domains as unknown as string) ?? []; } catch { return []; } })();
          return tags.length > 0 ? (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {tags.map((t) => (
                <span key={t} className="text-[10px] px-2 py-0.5 bg-ai-soft text-ai border border-line rounded-full">{t}</span>
              ))}
            </div>
          ) : null;
        })()}
        <p className="text-[11px] text-muted-2 mt-2">
          Added {new Date(conn.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
          {conn.last_ingested_at && (
            <span className="ml-2">
              · Ingested {new Date(conn.last_ingested_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          )}
          {isSourceConnector && conn.last_synced_at && (
            <span className="ml-2">
              · Last synced {new Date(conn.last_synced_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
          )}
        </p>
        {/* Sync + analysis status block — source-connector connections only.
            Shows the sync phase first (Queued → Syncing → Done), then
            transitions to analysis (profiling). The whole block disappears
            once the connection has been sitting idle in 'done' state. */}
        {isSourceConnector && (syncing || syncStatus || syncError || profilingPolling || profilingState.status === 'running' || profilingState.status === 'error') && (
          <div className="mt-2 px-3 py-2 rounded-md border border-line bg-softer text-[11.5px]">
            {/* Sync phase */}
            {syncing && (
              <p className="text-ink-2 font-mono">
                <span className="inline-block w-2 h-2 mr-2 bg-ocean rounded-full animate-pulse" />
                {syncStatus === 'queued' ? 'Queued…' : 'Syncing…'}
              </p>
            )}
            {!syncing && syncStatus === 'succeeded' && profilingState.status !== 'running' && profilingState.status !== 'error' && (
              <p className="text-ok font-mono">✓ Sync complete</p>
            )}
            {syncError && (
              <p className="text-rose-700 font-mono break-words">✗ {syncError}</p>
            )}
            {syncRowCounts && Object.keys(syncRowCounts).length > 0 && (
              <RowCountsList counts={syncRowCounts} />
            )}
            {/* Profiling / analysis phase */}
            {profilingState.status === 'running' && (
              <p className="text-ink-2 font-mono mt-1">
                <span className="inline-block w-2 h-2 mr-2 bg-ai rounded-full animate-pulse" />
                Analysing… {profilingState.message ?? ''}
                {typeof profilingState.progress === 'number' && profilingState.progress > 0 && (
                  <span className="ml-2 text-muted">{profilingState.progress}%</span>
                )}
              </p>
            )}
            {profilingState.status === 'done' && !syncing && (
              <p className="text-ok font-mono mt-1">✓ Ready — definitions available in the catalog</p>
            )}
            {profilingState.status === 'error' && (
              <p className="text-rose-700 font-mono mt-1 break-words">
                ✗ Analysis failed: {profilingState.message ?? 'unknown error'}
              </p>
            )}
          </div>
        )}
        {/* Contextual "what now?" hint — surfaces the recommended next action
            so users don't have to scan every button to know what to click. */}
        {nextStep && (
          <p className="mt-2 text-[12px] text-ink-3 leading-relaxed">
            <span className="text-muted-2 font-mono mr-1.5">→</span>{nextStep}
          </p>
        )}
        {/* Schema-changes panel — only fetches when the user landed here
            from a notification (?connectionId on URL matches this card).
            Shows the human-readable diff with per-table additions /
            removals / type changes, then hands off to Re-profile. */}
        {highlightedFromUrl && (
          <SchemaChangesPanel
            connId={conn.id}
            highlightedChangeId={highlightedSchemaChangeId}
            onReProfile={handleReProfile}
            reprofiling={reprofiling}
          />
        )}

        {/* Sync history panel — collapsed by default; loads on first expand. */}
        {isSourceConnector && historyOpen && (
          <div className="mt-2 px-3 py-2 rounded-md border border-line bg-raised text-[11.5px]">
            <p className="text-[10px] font-mono uppercase tracking-[0.06em] text-muted mb-2">Sync history</p>
            {historyLoading && <p className="text-muted">Loading…</p>}
            {!historyLoading && history && history.length === 0 && (
              <p className="text-muted">No sync runs yet.</p>
            )}
            {!historyLoading && history && history.length > 0 && (
              <ul className="space-y-1.5">
                {history.map((r) => {
                  const counts = typeof r.row_counts === 'string'
                    ? (() => { try { return JSON.parse(r.row_counts as string) as Record<string, number>; } catch { return {}; } })()
                    : (r.row_counts ?? {});
                  const totalRows = Object.values(counts as Record<string, number>).reduce((s, n) => s + (n || 0), 0);
                  const dur = r.started_at && r.completed_at
                    ? Math.round((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000)
                    : null;
                  const statusColor =
                    r.status === 'succeeded' ? 'text-ok'
                    : r.status === 'failed' ? 'text-rose-700'
                    : r.status === 'cancelled' ? 'text-muted'
                    : 'text-ai';
                  return (
                    <li key={r.id} className="border-t border-line pt-1.5 first:border-t-0 first:pt-0">
                      <div className="flex items-baseline gap-2">
                        <span className={`font-mono ${statusColor}`}>
                          {r.status === 'succeeded' ? '✓' : r.status === 'failed' ? '✗' : r.status === 'cancelled' ? '–' : '•'} {r.status}
                        </span>
                        <span className="text-muted">
                          {new Date(r.queued_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                        </span>
                        {dur !== null && (
                          <span className="text-muted-2 font-mono">· {dur}s</span>
                        )}
                        {totalRows > 0 && (
                          <span className="text-muted-2 font-mono">· {totalRows.toLocaleString()} rows</span>
                        )}
                      </div>
                      {r.error_message && (
                        <p className="text-rose-700 font-mono mt-0.5 break-words text-[11px]">{r.error_message}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {/* Schedule panel — set or edit a recurring sync. The schema-hash gate
            in the orchestrator means scheduled refreshes on stable schemas
            cost zero LLM tokens, so daily/hourly schedules are safe. */}
        {isSourceConnector && scheduleOpen && (
          <div className="mt-2 px-3 py-2 rounded-md border border-line bg-raised text-[11.5px]">
            <p className="text-[10px] font-mono uppercase tracking-[0.06em] text-muted mb-2">Sync schedule</p>
            {scheduleLoading && <p className="text-muted">Loading…</p>}
            {!scheduleLoading && (
              <div className="space-y-2">
                <p className="text-muted-2 leading-relaxed">
                  Standard 5-field cron (<span className="font-mono">m h dom mon dow</span>).
                  Examples: <span className="font-mono">0 6 * * *</span> (06:00 daily),
                  {' '}<span className="font-mono">0 */6 * * *</span> (every 6h),
                  {' '}<span className="font-mono">0 8 * * 1-5</span> (08:00 weekdays).
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-mono uppercase tracking-[0.06em] text-muted">Cron expression</span>
                    <input
                      type="text"
                      value={cronDraft}
                      onChange={(e) => setCronDraft(e.target.value)}
                      placeholder="0 6 * * *"
                      className="px-2 py-1 text-[12px] font-mono border border-line rounded-md bg-bg focus:outline-none focus:border-ocean"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-mono uppercase tracking-[0.06em] text-muted">Timezone (IANA)</span>
                    <input
                      type="text"
                      value={tzDraft}
                      onChange={(e) => setTzDraft(e.target.value)}
                      placeholder="Europe/Brussels"
                      className="px-2 py-1 text-[12px] font-mono border border-line rounded-md bg-bg focus:outline-none focus:border-ocean"
                    />
                  </label>
                </div>
                <label className="flex items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    checked={enabledDraft}
                    onChange={(e) => setEnabledDraft(e.target.checked)}
                    className="accent-ocean"
                  />
                  Enabled (uncheck to pause without losing the schedule)
                </label>
                {schedule?.next_run && enabledDraft && (
                  <p className="text-muted-2 font-mono text-[11px]">
                    Next run: {new Date(schedule.next_run).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                  </p>
                )}
                {scheduleError && (
                  <p className="text-rose-700 break-words font-mono text-[11px]">✗ {scheduleError}</p>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={saveSchedule}
                    disabled={scheduleSaving || !cronDraft.trim()}
                    className="px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {scheduleSaving ? 'Saving…' : (schedule ? 'Update schedule' : 'Save schedule')}
                  </button>
                  {schedule && (
                    <button
                      onClick={removeSchedule}
                      disabled={scheduleSaving}
                      className="px-3 py-1.5 text-[12px] bg-rose-50 border border-rose-200 text-rose-700 rounded-md hover:bg-rose-100 disabled:opacity-50 transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <p className="text-muted-2 text-[10.5px] mt-1 leading-relaxed">
                  Cost note: the orchestrator skips the LLM step when the schema is unchanged
                  since the last sync — scheduled refreshes on a stable schema have zero
                  Claude cost. First sync after a schema change runs a full analysis.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      {/* Tiered actions:
            1. Primary (filled ocean)   — the one thing they're most likely to want next.
            2. Secondary (ghost)         — useful but not urgent: history, schedule, re-analyse, edit.
            3. Destructive (muted err)   — separated by a thin divider so it doesn't sit
                                           shoulder-to-shoulder with the constructive actions. */}
      <div className="flex flex-col gap-1 shrink-0 w-[160px]">
        {/* Tier 1 — primary CTA. Sync is the main action for source connectors;
            direct-DB connections jump straight to viewing definitions. */}
        {isSourceConnector ? (
          <button
            onClick={handleSyncNow}
            disabled={syncing}
            className="px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        ) : (
          <button
            onClick={() => router.push(`/semantic?connectionId=${conn.id}`)}
            className="px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
          >
            View in catalog
          </button>
        )}
        {/* For source connectors, viewing the catalog is the natural follow-up
            once a sync is done — promote it to a secondary CTA so it's visible
            but doesn't compete with Sync now. */}
        {isSourceConnector && (
          <button
            onClick={() => router.push(`/semantic?connectionId=${conn.id}`)}
            className="px-3 py-1.5 text-[12px] font-medium bg-ocean-softer text-ocean border border-ocean-soft rounded-md hover:bg-ocean-softer/70 transition-colors"
          >
            View in catalog
          </button>
        )}

        {/* Tier 2 — operational secondaries. Grouped visually with a tighter
            gap; muted styling so they read as "available but not the main
            action". */}
        <div className="h-px bg-line my-1" />
        {isSourceConnector && (
          <button
            onClick={toggleHistory}
            className="px-3 py-1.5 text-[12px] bg-raised border border-line text-ink-2 rounded-md hover:bg-softer hover:border-line-strong transition-colors"
          >
            {historyOpen ? 'Hide history' : 'Sync history'}
          </button>
        )}
        {isSourceConnector && (
          <button
            onClick={toggleSchedule}
            className="px-3 py-1.5 text-[12px] bg-raised border border-line text-ink-2 rounded-md hover:bg-softer hover:border-line-strong transition-colors"
          >
            {scheduleOpen ? 'Hide schedule' : (schedule ? 'Schedule · on' : 'Schedule')}
          </button>
        )}
        {/* "Analyse" until the AI pass has run at least once; "Re-analyse"
            after. Emphasised while the source is synced-but-unanalysed so
            the remaining step is impossible to miss. */}
        <button
          onClick={handleReProfile}
          disabled={reprofiling}
          className={
            profilingState.status === 'done' || profilingState.status === 'error'
              ? 'px-3 py-1.5 text-[12px] bg-raised border border-line text-ink-2 rounded-md hover:bg-softer hover:border-line-strong transition-colors disabled:opacity-50'
              : 'px-3 py-1.5 text-[12px] bg-ocean text-white border border-ocean rounded-md hover:bg-ocean-hover transition-colors disabled:opacity-50'
          }
        >
          {reprofiling
            ? 'Analysing…'
            : (profilingState.status === 'done' || profilingState.status === 'error' ? 'Re-analyse' : 'Analyse')}
        </button>
        {/* Enrichment only makes sense on an analysed catalog (vendor bases
            persisted). Admin-only server-side; drafts land in the review
            queue, vendor text stays the immutable base. */}
        {profilingState.status === 'done' && (
          <button
            onClick={handleEnrich}
            disabled={enriching}
            className="px-3 py-1.5 text-[12px] bg-raised border border-line text-ink-2 rounded-md hover:bg-softer hover:border-line-strong transition-colors disabled:opacity-50"
          >
            {enriching ? 'Enriching…' : 'Enrich descriptions'}
          </button>
        )}
        <button
          onClick={() => onEdit(conn)}
          className="px-3 py-1.5 text-[12px] bg-raised border border-line text-ink-2 rounded-md hover:bg-softer hover:border-line-strong transition-colors"
        >
          Edit
        </button>
        {/* Re-ingest is for direct-DB connections (the legacy ETL path) — hidden
            for source-connector connections, which use "Sync now" instead. */}
        {!isSourceConnector && (
          <button
            onClick={() => onReIngest(conn)}
            className="px-3 py-1.5 text-[12px] bg-raised border border-line text-ink-2 rounded-md hover:bg-softer hover:border-line-strong transition-colors"
          >
            Re-ingest
          </button>
        )}

        {/* Tier 3 — destructive. Sits below a divider, smaller visual weight,
            requires an explicit click. */}
        <div className="h-px bg-line my-1" />
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="px-3 py-1.5 text-[12px] text-err border border-line rounded-md bg-raised hover:bg-err-soft transition-colors disabled:opacity-50"
        >
          {deleting ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RowCountsList — compact, sorted, collapsible table of row counts per
// entity from the most recent sync. Replaces the inline `a: 1 · b: 2 · …`
// line which became unreadable as soon as the entity list grew past a
// handful. Shows the top 5 by row count by default; an expand toggle
// reveals the rest.
// ---------------------------------------------------------------------------

function RowCountsList({ counts }: { counts: Record<string, number> }) {
  const [expanded, setExpanded] = useState(false);
  const sorted = Object.entries(counts).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const visible = expanded ? sorted : sorted.slice(0, 5);
  const total = sorted.reduce((sum, [, n]) => sum + (n || 0), 0);
  const hidden = sorted.length - visible.length;

  return (
    <div className="mt-1.5">
      <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[11.5px] font-mono">
        {visible.map(([name, n]) => (
          <Fragment key={name}>
            <span className="text-muted-2 truncate" title={name}>{name}</span>
            <span className="text-ink-3 tabular-nums">{n.toLocaleString()}</span>
          </Fragment>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-1 text-[11px]">
        <span className="text-muted-2 font-mono tabular-nums">
          Total: {total.toLocaleString()} rows · {sorted.length} {sorted.length === 1 ? 'entity' : 'entities'}
        </span>
        {hidden > 0 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-ocean hover:underline"
          >
            {expanded ? 'Show less' : `Show ${hidden} more`}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConnectorTile
// ---------------------------------------------------------------------------

function ConnectorTile({ connector, onClick }: { connector: Connector; onClick: () => void }) {
  return (
    <button
      onClick={connector.available ? onClick : undefined}
      disabled={!connector.available}
      className={`relative bg-raised border border-line rounded-lg p-4 text-left transition-colors flex flex-col gap-3 ${
        connector.available
          ? 'hover:border-ocean/40 hover:bg-ocean-softer cursor-pointer group'
          : 'opacity-50 cursor-default'
      }`}
    >
      {!connector.available && (
        <span className="absolute top-2.5 right-2.5 text-[10px] font-mono tracking-[0.08em] uppercase text-muted-2 bg-softer border border-line px-1.5 py-0.5 rounded">
          Coming soon
        </span>
      )}
      <ConnectorIcon connector={connector} size="md" />
      <div>
        <p className="text-[14px] font-medium text-ink">{connector.name}</p>
        <p className="text-[12px] text-ink-3 mt-0.5 leading-relaxed">{connector.description}</p>
      </div>
      {connector.available && (
        <span className="text-[11px] font-mono tracking-[0.08em] uppercase text-ocean">Connect →</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// SlidePanel — create or edit a connection
// ---------------------------------------------------------------------------

function SlidePanel({
  connector,
  editConnection,
  onClose,
  onConnected,
  onUpdated,
  isOAuth,
  connectorType,
}: {
  connector: Connector;
  editConnection?: Connection;        // present → edit mode
  onClose: () => void;
  onConnected: (id: number, name: string) => void;
  onUpdated: (conn: Connection) => void;
  isOAuth?: boolean;
  connectorType?: string;
}) {
  const isEdit = !!editConnection;

  // Seed state from existing connection when editing
  const initialConfig = editConnection ? getConfig(editConnection) : {};
  const [name, setName] = useState(editConnection?.name ?? '');
  const [fields, setFields] = useState<Record<string, string>>(
    Object.fromEntries(connector.formFields.map((f) => [f.key, (initialConfig as Record<string, string>)[f.key] ?? '']))
  );
  const [domains, setDomains] = useState<string[]>(
    (() => {
      const raw = editConnection?.domains;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      try { return JSON.parse(raw as unknown as string) ?? []; } catch { return []; }
    })()
  );
  const [domainInput, setDomainInput] = useState('');
  // In edit mode start as 'ok' so Save is enabled immediately (path is already valid)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>(isEdit ? 'ok' : 'idle');
  const [testMsg, setTestMsg] = useState(isEdit ? 'Connection previously verified' : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);

  async function handleOAuthReconnect() {
    if (!isOAuth || !connectorType || !editConnection) return;
    setReconnecting(true);
    setError('');
    try {
      const initRes = await api.post(
        `/source-types/${connectorType}/oauth-init`,
        { config: Object.fromEntries(Object.entries(fields).filter(([, v]) => v && v !== '••••••••').map(([k, v]) => [k, v])) },
      );
      const data = initRes.data?.data as { authUrl: string; stateToken: string } | undefined;
      if (!data?.authUrl || !data?.stateToken) {
        throw new Error('oauth-init returned an unexpected response');
      }
      const w = 600, h = 720;
      const left = (window.screen.width  - w) / 2 + (window.screenLeft ?? 0);
      const top  = (window.screen.height - h) / 2 + (window.screenTop  ?? 0);
      const popup = window.open(
        data.authUrl,
        'clarion-oauth',
        `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no`,
      );
      if (!popup) {
        throw new Error('Popup blocked — please allow popups for this site and try again');
      }
      const result = await new Promise<{ ok: true; code: string; state: string } | { ok: false; error: string }>((resolve, reject) => {
        let resolved = false;
        const accept = (m: { kind?: string; ok?: boolean; code?: string; state?: string; error?: string } | undefined) => {
          if (!m || m.kind !== 'clarion:oauth') return false;
          if (resolved) return true;
          resolved = true;
          channel.close();
          window.removeEventListener('message', onMessage);
          clearInterval(closedCheck);
          if (m.ok && m.code && m.state) resolve({ ok: true, code: m.code, state: m.state });
          else resolve({ ok: false, error: m.error ?? 'OAuth failed' });
          return true;
        };
        const channel = new BroadcastChannel('clarion-oauth');
        channel.onmessage = (ev) => { accept(ev.data); };
        const onMessage = (ev: MessageEvent) => {
          if (ev.origin !== window.location.origin) return;
          accept(ev.data);
        };
        window.addEventListener('message', onMessage);
        let closedSince: number | null = null;
        const closedCheck = setInterval(() => {
          if (resolved) return;
          if (popup.closed) {
            if (closedSince === null) closedSince = Date.now();
            else if (Date.now() - closedSince > 1500) {
              if (resolved) return;
              resolved = true;
              channel.close();
              window.removeEventListener('message', onMessage);
              clearInterval(closedCheck);
              reject(new Error('Popup closed before authorization completed'));
            }
          } else {
            closedSince = null;
          }
        }, 300);
      });
      if (!result.ok) throw new Error(result.error ?? 'OAuth authorization failed');
      if (result.state !== data.stateToken) throw new Error('OAuth state mismatch');

      await api.post(`/source-types/${connectorType}/oauth-finish`, {
        stateToken: data.stateToken,
        code: result.code,
      });
      await api.post(`/connections/${editConnection.id}/oauth-reconnect`, {
        oauthStateToken: data.stateToken,
      });

      setTestStatus('ok');
      setTestMsg('Re-authenticated successfully — fresh tokens stored');
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })
        ?.response?.data?.error
        ?? (err as Error)?.message
        ?? 'Re-authentication failed';
      setError(msg);
    } finally {
      setReconnecting(false);
    }
  }

  function addDomain(value: string) {
    const tag = value.trim().toLowerCase();
    if (!tag || domains.includes(tag)) return;
    setDomains((prev) => [...prev, tag]);
    setDomainInput('');
  }

  function removeDomain(tag: string) {
    setDomains((prev) => prev.filter((d) => d !== tag));
  }

  function setField(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    // Any field change in edit mode requires re-testing
    if (isEdit) {
      setTestStatus('idle');
      setTestMsg('');
    }
  }

  /** Convert string booleans and number ports to their real types for the backend. */
  function normalizeConfig(raw: Record<string, string>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!v.trim()) continue; // skip empty optional fields
      if (k === 'port') { result[k] = Number(v) || v; }
      else if (['ssl', 'encrypt', 'trustServerCertificate', 'windowsAuth'].includes(k)) {
        result[k] = v.toLowerCase() === 'true';
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  async function handleTest() {
    setTestStatus('testing');
    setTestMsg('');
    try {
      const res = await api.post('/connections/test', { type: connector.id, config: normalizeConfig(fields) });
      if (res.data.ok) {
        setTestStatus('ok');
        setTestMsg(res.data.data?.message ?? 'Connection successful');
      } else {
        setTestStatus('fail');
        setTestMsg(res.data.error ?? 'Connection failed');
      }
    } catch {
      setTestStatus('fail');
      setTestMsg('Connection failed. Check the path and try again.');
    }
  }

  async function handleSave() {
    if (!name.trim()) { setError('Please enter a name for this connection.'); return; }
    setError('');
    setSaving(true);
    try {
      const normalizedCfg = normalizeConfig(fields);
      if (isEdit) {
        const isSourceConnector = !!editConnection!.connector_type;
        // Update name + domains via the standard PATCH
        await api.patch(`/connections/${editConnection!.id}`, {
          name: name.trim(),
          ...(!isSourceConnector ? { config: normalizedCfg } : {}),
          domains,
        });
        // For source connectors, also update the connector config if fields were changed
        if (isSourceConnector && connector.formFields.length > 0) {
          await api.patch(`/connections/${editConnection!.id}/source-config`, {
            config: normalizedCfg,
          });
        }
        onUpdated({ ...editConnection!, name: name.trim(), config: fields, domains });
      } else {
        const res = await api.post('/connections', {
          name: name.trim(),
          type: connector.id,
          config: normalizedCfg,
          domains,
        });
        onConnected(res.data.data.connectionId, name.trim());
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? (isEdit ? 'Failed to save changes.' : 'Failed to create connection.'));
    } finally {
      setSaving(false);
    }
  }

  const allFilled = connector.formFields.every((f) => (fields[f.key] ?? '').trim());

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-ink/40 backdrop-blur-[2px] z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-md bg-raised border-l border-line shadow-2 z-50 flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-5 border-b border-line">
          <ConnectorIcon connector={connector} size="md" />
          <div>
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-0.5">
              {isEdit ? 'Edit source' : 'New source'}
            </p>
            <h2 className="font-display text-[18px] text-ink leading-tight tracking-[-0.01em]">
              {isEdit ? editConnection!.name : connector.name}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="ml-auto w-8 h-8 flex items-center justify-center rounded-md text-muted hover:text-ink-2 hover:bg-softer transition-colors"
            title="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          {/* Connection name */}
          <div>
            <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Connection name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sample SQLite DB"
              className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors"
            />
          </div>

          {/* Dynamic fields */}
          {connector.formFields.map((f) => (
            <div key={f.key}>
              <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">{f.label}</label>
              <input
                type={f.type}
                value={fields[f.key] ?? ''}
                onChange={(e) => setField(f.key, e.target.value)}
                placeholder={f.placeholder}
                className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] font-mono text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors"
              />
              {f.hint && <p className="text-[11px] text-muted mt-1 leading-relaxed">{f.hint}</p>}
            </div>
          ))}

          {/* Data domains */}
          <div>
            <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">
              Data domains <span className="text-muted-2 normal-case">(optional)</span>
            </label>
            <p className="text-[11px] text-muted mb-2 leading-relaxed">
              Tags set here apply to all tables in this source. You can still add extra tags on individual tables.
            </p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {domains.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1.5 text-[11px] bg-ai-soft text-ai border border-line rounded-md px-2 py-0.5">
                  {tag}
                  <button type="button" onClick={() => removeDomain(tag)} className="hover:text-ai/80 leading-none">&times;</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addDomain(domainInput); } }}
                placeholder="e.g. sales, hr, finance — press Enter to add"
                className="flex-1 bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors"
              />
              <button
                type="button"
                onClick={() => addDomain(domainInput)}
                className="px-4 py-2 text-[13px] bg-raised border border-line hover:bg-softer hover:border-line-strong text-ink-2 rounded-md transition-colors"
              >Add</button>
            </div>
          </div>

          {/* Test result */}
          {testStatus === 'ok' && (
            <div className="flex items-center gap-2 text-[13px] text-ok bg-ok-soft border border-line rounded-md px-3 py-2">
              <span className="orb-approved" /> {testMsg}
            </div>
          )}
          {testStatus === 'fail' && (
            <div className="flex items-start gap-2 text-[13px] text-err bg-err-soft border border-line rounded-md px-3 py-2">
              <span className="orb-rejected mt-1" /> {testMsg}
            </div>
          )}

          {error && <p className="text-[13px] text-err">{error}</p>}

          {/* Info note */}
          {!isEdit && (
            <div className="bg-softer border border-line rounded-md p-4 text-[12px] text-ink-3 space-y-1 leading-relaxed">
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1">What happens when you connect?</p>
              <p>1. Clarion tests the connection to make sure it works.</p>
              <p>2. You pick which tables to ingest into the data warehouse.</p>
              <p>3. Data is ingested as Delta Lake tables for fast querying.</p>
              <p>4. The schema is profiled and Claude generates definitions for your review.</p>
            </div>
          )}
          {isEdit && connector.formFields.length > 0 && (
            <div className="bg-warn-soft border border-line rounded-md p-4 text-[12px] text-ink-2 space-y-1 leading-relaxed">
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-warn mb-1">Changing connection details?</p>
              <p>Test the connection first, then save. If you point to a different database, use Re-analyse to regenerate definitions.</p>
            </div>
          )}
          {isEdit && !!editConnection?.connector_type && (
            <div className="bg-warn-soft border border-line rounded-md p-4 text-[12px] text-ink-2 space-y-1 leading-relaxed">
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-warn mb-1">Source connector</p>
              <p>You can update the name, data domains, and connection details. Sensitive fields (secrets, tokens) are shown as masked — leave them unchanged unless you need to rotate credentials. Changes take effect on the next sync.</p>
              {isOAuth && <p>If syncs are failing due to expired tokens, use the <strong>Re-authenticate</strong> button below to get fresh credentials.</p>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-line flex flex-col gap-2">
          {isEdit && isOAuth && (
            <button
              onClick={handleOAuthReconnect}
              disabled={reconnecting}
              className="w-full px-4 py-2 text-[13px] font-medium bg-warn-soft text-warn border border-warn/30 rounded-md hover:bg-warn/15 disabled:opacity-40 transition-colors"
            >
              {reconnecting ? 'Authenticating…' : `Re-authenticate with ${connector.name}`}
            </button>
          )}
          <div className="flex gap-2">
            {connector.formFields.length > 0 && !editConnection?.connector_type && (
              <button
                onClick={handleTest}
                disabled={!allFilled || testStatus === 'testing'}
                className="px-4 py-2 text-[13px] bg-raised border border-line rounded-md hover:bg-softer hover:border-line-strong disabled:opacity-40 transition-colors text-ink-2"
              >
                {testStatus === 'testing' ? 'Testing…' : 'Test connection'}
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={(connector.formFields.length > 0 && !editConnection?.connector_type && testStatus !== 'ok') || saving}
              className="flex-1 px-4 py-2 text-[13px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-40 transition-colors"
            >
              {saving
                ? (isEdit ? 'Saving…' : 'Saving & analysing…')
                : (isEdit ? 'Save changes' : 'Save & analyse')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// ProfilingBanner — SSE-driven real-time progress
// ---------------------------------------------------------------------------

const PHASE_META: Record<string, { icon: string; label: string; order: number }> = {
  schema:   { icon: '~', label: 'Reading schema',                order: 0 },
  quality:  { icon: '#', label: 'Profiling data quality',        order: 1 },
  ai_draft: { icon: '*', label: 'Claude is learning your data',  order: 2 },
  storing:  { icon: '>', label: 'Saving definitions',            order: 3 },
  neo4j:    { icon: '+', label: 'Syncing knowledge graph',       order: 4 },
  done:     { icon: '!', label: 'Complete',                      order: 5 },
};
const PHASE_KEYS = ['schema', 'quality', 'ai_draft', 'storing', 'neo4j', 'done'];

function ProfilingBanner({ name, connId, onDismiss, startStream }: {
  name: string;
  connId: number;
  onDismiss: () => void;
  startStream?: boolean;
}) {
  const router = useRouter();
  const [currentPhase, setCurrentPhase] = useState('schema');
  const [message, setMessage] = useState('Starting analysis…');
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState('');
  // Set true when the SSE stream is cut mid-profile but the server-side
  // profile is still running (status != done|error). Azure Container Apps
  // drops long-lived HTTP connections at ~4 minutes; a heavy profile
  // can take 10+ min. Without this flag, the banner used to flip to a
  // red "Profiling failed" state at the 4-min mark and the user had to
  // refresh manually. With it, we silently switch to DB polling so live
  // progress continues until the profile completes or errors for real.
  const [pollingFallback, setPollingFallback] = useState(false);

  useEffect(() => {
    if (!startStream || !connId) return;

    const token = getToken();
    const abortCtrl = new AbortController();

    (async () => {
      try {
        await streamSSE(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'}/connections/${connId}/profile`, {
          method: 'POST',
          signal: abortCtrl.signal,
          onEvent: (evt) => {
            if (evt.phase === 'done') {
              setCurrentPhase('done');
              setDoneMessage(evt.message ?? 'Analysis complete');
              setFinished(true);
            } else if (evt.phase === 'error') {
              setError(evt.message ?? 'Profiling failed');
            } else {
              setCurrentPhase(evt.phase);
              setMessage(evt.message);
            }
          },
        });
        // Stream ended without explicit done/error — almost always means
        // Azure Container Apps' Envoy proxy cut the long-lived SSE
        // connection at its ~4 min timeout. The server-side profile is
        // still running. Probe the DB to decide what to do:
        //   • status='done'   → mark finished
        //   • status='error'  → real failure, surface it
        //   • else (running)  → flip on `pollingFallback`, which un-gates
        //     the polling effect below. Live progress keeps flowing,
        //     just from DB polls instead of the dead stream.
        if (!finished && !error) {
          try {
            const statusRes = await fetch(
              `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'}/connections/${connId}/profile/status`,
              { headers: token ? { 'Authorization': `Bearer ${token}` } : {} },
            );
            const statusData = await statusRes.json();
            const d = statusData?.data;
            if (d?.profiling_status === 'done') {
              setCurrentPhase('done');
              setDoneMessage(d.profiling_message ?? 'Analysis complete');
              setFinished(true);
            } else if (d?.profiling_status === 'error') {
              setError(d.profiling_message ?? 'Profiling failed');
            } else {
              // Server-side profile is still running. Don't show an error
              // — flip to polling mode and keep the live banner intact.
              setPollingFallback(true);
            }
          } catch {
            // Status probe itself failed (network blip, auth refresh).
            // Be optimistic: assume the profile is still running and try
            // polling. The polling effect will catch up if it can.
            setPollingFallback(true);
          }
        }
      } catch (err) {
        if (err instanceof SSEHttpError) {
          console.error('[ProfilingBanner] stream failed:', err.status, err.detail);
          setError(`Failed to start profiling stream (${err.status})`);
        } else if ((err as Error).name !== 'AbortError') {
          // Same logic as the stream-ended branch — server-side might
          // still be running, prefer polling over a red error banner.
          setPollingFallback(true);
        }
      }
    })();

    return () => abortCtrl.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startStream, connId]);

  // Poll for profiling status when:
  //   • The banner was opened cold (no live stream — `startStream` is
  //     false because the user landed on the page mid-profile), OR
  //   • The SSE stream dropped and we flipped `pollingFallback` on.
  useEffect(() => {
    if ((startStream && !pollingFallback) || !connId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await api.get(`/connections/${connId}/profile/status`);
        const d = res.data?.data;
        if (!d || cancelled) return;

        if (d.profiling_status === 'done') {
          setCurrentPhase('done');
          setDoneMessage(d.profiling_message ?? 'Analysis complete');
          setFinished(true);
          return; // stop polling
        }
        if (d.profiling_status === 'error') {
          setError(d.profiling_message ?? 'Profiling failed');
          return; // stop polling
        }
        // Still running — update UI and continue polling
        if (d.profiling_phase) setCurrentPhase(d.profiling_phase);
        if (d.profiling_message) setMessage(d.profiling_message);
      } catch { /* ignore fetch errors, will retry */ }

      if (!cancelled) {
        setTimeout(poll, 2000); // poll every 2s
      }
    };

    poll();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startStream, connId, pollingFallback]);

  if (error) {
    return (
      <div className="bg-err-soft border border-line rounded-lg p-5 panel-enter">
        <div className="flex items-center gap-3">
          <span className="orb-rejected" />
          <div>
            <p className="text-[13px] font-medium text-ink">Profiling failed</p>
            <p className="text-[12px] text-err mt-0.5">{error}</p>
          </div>
          <button onClick={onDismiss} className="ml-auto w-7 h-7 flex items-center justify-center rounded-md text-muted hover:text-ink-2 hover:bg-softer transition-colors">×</button>
        </div>
      </div>
    );
  }

  if (finished) {
    return (
      <div className="bg-ok-soft border border-line rounded-lg p-5 panel-enter">
        <div className="flex items-center gap-3 mb-3">
          <span className="orb-approved" />
          <div>
            <p className="text-[13px] font-medium text-ink">Analysis complete for {name}</p>
            <p className="text-[12px] text-ok mt-0.5">{doneMessage || 'Quality profiles, definitions and relationships are ready.'}</p>
          </div>
          <button onClick={onDismiss} className="ml-auto w-7 h-7 flex items-center justify-center rounded-md text-muted hover:text-ink-2 hover:bg-softer transition-colors">×</button>
        </div>
        <button
          onClick={() => router.push(`/semantic?connectionId=${connId}`)}
          className="mt-1 w-full px-4 py-2 text-[13px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
        >
          Review definitions →
        </button>
      </div>
    );
  }

  const currentOrder = PHASE_META[currentPhase]?.order ?? 0;
  const progress = Math.round(((currentOrder + 1) / PHASE_KEYS.length) * 100);

  return (
    <div className="bg-raised border border-line rounded-lg p-5 panel-enter">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <span className="orb-draft" />
        <p className="text-[13px] text-ink">Analysing <span className="font-medium text-ocean">{name}</span></p>
        {pollingFallback && (
          // Subtle hint. The user previously saw a red "Connection to
          // server lost" banner here, which made it look like profiling
          // had failed when it was still running. This badge replaces
          // that experience with an accurate (and calmer) "we lost the
          // stream but are polling the DB" message.
          <span
            className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted-2 border border-line bg-softer px-1.5 py-0.5 rounded"
            title="Live stream dropped after ~4 min (Azure platform limit); polling the database every 2s instead. Progress is real."
          >
            polling
          </span>
        )}
        <span className="ml-auto text-[10px] font-mono tracking-[0.08em] uppercase text-muted tabular-nums">{progress}%</span>
      </div>

      {/* Progress bar */}
      <div className="w-full h-1 bg-softer rounded-full mb-4 overflow-hidden">
        <div
          className="h-full bg-ocean rounded-full transition-all duration-700 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Steps */}
      <div className="space-y-1">
        {PHASE_KEYS.filter((k) => k !== 'done').map((phaseKey) => {
          const meta = PHASE_META[phaseKey];
          const isDone    = meta.order < currentOrder;
          const isActive  = phaseKey === currentPhase;
          return (
            <div key={phaseKey} className={`flex items-center gap-3 rounded-md px-3 py-2 transition-colors ${isActive ? 'bg-ocean-softer' : ''}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] shrink-0 ${
                isDone   ? 'bg-ok-soft text-ok border border-line' :
                isActive ? 'bg-ocean-soft text-ocean border border-line' :
                           'bg-softer text-muted-2 border border-line'
              }`}>
                {isDone ? '✓' : isActive ? (
                  <span className="block w-3 h-3 border-2 border-ocean border-t-transparent rounded-full animate-spin" />
                ) : meta.icon}
              </div>
              <div className="min-w-0">
                <p className={`text-[12px] ${isDone ? 'text-ok' : isActive ? 'text-ink' : 'text-muted-2'}`}>
                  {meta.label}
                </p>
                {isActive && (
                  <p className="text-[11px] text-muted mt-0.5">{message}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyWorkspaceHero — first-run landing for a fresh workspace
// ---------------------------------------------------------------------------

function ObservatoryMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className="text-ocean">
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="16" cy="16" r="8"  stroke="currentColor" strokeWidth="1"   />
      <circle cx="16" cy="16" r="3"  fill="currentColor" />
    </svg>
  );
}

function EmptyWorkspaceHero({
  onConnect,
  onSample,
  currentStep = 1,
}: {
  onConnect: () => void;
  onSample?: () => void;
  currentStep?: 1 | 2 | 3;
}) {
  const steps: Array<{ n: number; label: string }> = [
    { n: 1, label: 'Connect' },
    { n: 2, label: 'Profile' },
    { n: 3, label: 'Ask' },
  ];

  return (
    <div
      className="relative rounded-lg border border-line overflow-hidden bg-raised"
      style={{
        backgroundImage: 'radial-gradient(circle, var(--line) 1px, transparent 1px)',
        backgroundSize: '28px 28px',
        backgroundPosition: '-1px -1px',
      }}
    >
      <div className="flex flex-col items-center justify-center text-center px-6 py-20 md:py-28">
        {/* Observatory mark with pulsing ring */}
        <div className="relative mb-7">
          <span
            className="absolute inset-0 rounded-full bg-ocean-soft opacity-50 animate-ping"
            style={{ animationDuration: '2.4s' }}
            aria-hidden="true"
          />
          <span className="relative inline-flex items-center justify-center">
            <ObservatoryMark size={72} />
          </span>
        </div>

        {/* Headline */}
        <h1 className="font-display font-medium text-[52px] leading-[1.05] tracking-[-0.03em] text-ink m-0">
          Let&rsquo;s look inside
          <br />
          <em className="italic font-normal text-ink-2">your company.</em>
        </h1>

        {/* Subcopy */}
        <p className="mt-5 max-w-[560px] font-display text-[17px] leading-[1.55] text-ink-2 m-0">
          Connect a source and Clarion will profile it, learn what every column means,
          and make it ready for plain-language questions.
        </p>

        {/* CTAs */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onConnect}
            className="inline-flex items-center gap-2 font-sans font-medium leading-none px-[22px] py-[12px] text-[14.5px] rounded-sm border bg-ocean text-white border-ocean hover:bg-ocean-hover hover:border-ocean-hover transition-all duration-1 ease-observatory focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]"
          >
            Connect your first source
          </button>
          {onSample && (
            <button
              type="button"
              onClick={onSample}
              className="inline-flex items-center gap-2 font-sans font-medium leading-none px-[22px] py-[12px] text-[14.5px] rounded-sm border bg-raised text-ink border-line hover:border-line-strong hover:bg-softer transition-all duration-1 ease-observatory focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]"
            >
              Explore with sample data
            </button>
          )}
        </div>

        {/* Journey steps */}
        <ol className="mt-10 flex items-center gap-5 font-mono text-[10.5px] uppercase tracking-[0.1em] font-medium text-muted-2 m-0 p-0 list-none">
          {steps.map((s, i) => {
            const active = s.n === currentStep;
            const done = s.n < currentStep;
            return (
              <li key={s.n} className="flex items-center gap-5">
                <span className={`flex items-center gap-2 ${active ? 'text-ocean' : done ? 'text-ink-3' : 'text-muted-2'}`}>
                  <span className={`tabular-nums ${active ? 'text-ocean' : ''}`}>{s.n}</span>
                  <span>{s.label}</span>
                </span>
                {i < steps.length - 1 && <span className="text-line-strong" aria-hidden="true">·</span>}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function SourcesPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Schema-drift notifications fire links like
  //   /sources?connectionId=12&schemaChange=47
  // We pluck both so the matching ConnectionCard can auto-open the
  // SchemaChangesPanel pre-expanded on the right row.
  const urlConnectionId = (() => {
    const v = Number(searchParams.get('connectionId'));
    return Number.isFinite(v) && v > 0 ? v : null;
  })();
  const urlSchemaChangeId = (() => {
    const v = Number(searchParams.get('schemaChange'));
    return Number.isFinite(v) && v > 0 ? v : null;
  })();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [panelConnector, setPanelConnector] = useState<Connector | null>(null);
  const [editingConn, setEditingConn] = useState<Connection | null>(null);
  const [editingIsOAuth, setEditingIsOAuth] = useState(false);
  const [profiling, setProfiling] = useState<{ id: number; name: string; startStream?: boolean } | null>(null);
  const [ingesting, setIngesting] = useState<{ id: number; name: string } | null>(null);
  // Registry-driven connectors (ExactOnline today; NetSuite/QuickBooks/etc. later).
  // Fetched from the backend so adding a new connector to the registry makes it
  // show up here automatically — no frontend change per connector.
  const [registryConnectors, setRegistryConnectors] = useState<Connector[]>([]);
  // A live registry connector always wins over a hardcoded tile of the same id.
  // Without this the two lists can each render the same product — which is
  // exactly what happened to Exact Online: a stale "coming soon" placeholder
  // beside the working tile.
  const registryIds = new Set(registryConnectors.map((c) => c.id));
  const staticConnectors = CONNECTORS.filter((c) => !registryIds.has(c.id));

  useEffect(() => {
    api.get('/connections')
      .then((res) => {
        const conns: Connection[] = res.data.data ?? [];
        setConnections(conns);
        // Resume profiling banner if any connection is still being profiled
        const running = conns.find((c: any) => c.profiling_status === 'running');
        if (running && !profiling) {
          setProfiling({ id: running.id, name: running.name, startStream: false });
        }
      })
      .catch(() => setConnections([]))
      .finally(() => setLoading(false));
  }, []);

  // Load registry connectors. Each becomes a tile in the "Add a source" grid;
  // clicking routes to the wizard with the type pre-selected.
  useEffect(() => {
    api.get('/source-types')
      .then((res) => {
        const types: Array<{ type: string; displayName: string; iconSvg?: string }> =
          res.data?.data ?? [];
        setRegistryConnectors(
          types.map((t) => ({
            id: t.type,
            name: t.displayName,
            description: REGISTRY_DESCRIPTIONS[t.type] ?? 'API source. Sync data into your warehouse.',
            available: true,
            color: REGISTRY_COLORS[t.type] ?? 'bg-amber-500',
            iconLetter: t.displayName.charAt(0).toUpperCase(),
            // formFields not used — we route to the wizard which renders the form from JSON Schema.
            formFields: [],
          })),
        );
      })
      .catch(() => setRegistryConnectors([]));
  }, []);

  async function openEdit(conn: Connection) {
    if (conn.connector_type) {
      const reg = registryConnectors.find((c) => c.id === conn.connector_type);
      // Fetch the config schema from source-types and current config from the backend
      try {
        const [typesRes, configRes] = await Promise.all([
          api.get('/source-types'),
          api.get(`/connections/${conn.id}/source-config`),
        ]);
        const typeMeta = (typesRes.data?.data ?? []).find(
          (t: { type: string }) => t.type === conn.connector_type,
        );
        const currentConfig = configRes.data?.data ?? {};
        const schema = typeMeta?.configSchema;
        // Build formFields from the JSON Schema, filtering to preAuthFields
        // (the fields shown before OAuth — the ones the user can meaningfully edit)
        const preAuth: string[] = typeMeta?.oauth?.preAuthFields ?? [];
        const editableKeys = preAuth.length > 0
          ? preAuth
          : schema ? Object.keys(schema.properties ?? {}) : [];
        const formFields: FormField[] = editableKeys
          .filter((key: string) => schema?.properties?.[key])
          .map((key: string) => {
            const prop = schema.properties[key];
            const isSensitive = /(secret|password|token|apikey|api_key)/i.test(key);
            return {
              key,
              label: prop.title ?? key,
              placeholder: prop.default !== undefined ? String(prop.default) : '',
              type: (isSensitive ? 'password' : prop.type === 'integer' || prop.type === 'number' ? 'number' : 'text') as FormField['type'],
              hint: prop.description,
            };
          });
        const synth: Connector = {
          id: conn.connector_type,
          name: reg?.name ?? conn.connector_type,
          description: reg?.description ?? 'Source connector',
          available: true,
          color: reg?.color ?? 'bg-teal-500',
          iconLetter: reg?.iconLetter ?? conn.connector_type.charAt(0).toUpperCase(),
          formFields,
        };
        // Inject the current config into the connection object so SlidePanel picks it up
        setEditingConn({ ...conn, config: currentConfig });
        setEditingIsOAuth(!!typeMeta?.oauth);
        setPanelConnector(synth);
      } catch {
        // Fallback: open with name+domains only
        const synth: Connector = {
          id: conn.connector_type,
          name: reg?.name ?? conn.connector_type,
          description: reg?.description ?? 'Source connector',
          available: true,
          color: reg?.color ?? 'bg-teal-500',
          iconLetter: reg?.iconLetter ?? conn.connector_type.charAt(0).toUpperCase(),
          formFields: [],
        };
        setEditingConn(conn);
        setEditingIsOAuth(false);
        setPanelConnector(synth);
      }
      return;
    }
    const connector = connectorForType(conn.type);
    if (!connector) return;
    setEditingConn(conn);
    setEditingIsOAuth(false);
    setPanelConnector(connector);
  }

  function closePanel() {
    setPanelConnector(null);
    setEditingConn(null);
    setEditingIsOAuth(false);
  }

  function handleConnected(id: number, name: string) {
    closePanel();
    // Show ingestion wizard first, then profile
    setIngesting({ id, name });
    api.get('/connections').then((res) => setConnections(res.data.data ?? []));
  }

  function handleUpdated(updated: Connection) {
    setConnections((prev) => prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)));
    closePanel();
  }

  function handleDelete(id: number) {
    setConnections((prev) => prev.filter((c) => c.id !== id));
  }

  function handleReIngest(conn: Connection) {
    // Show ingestion wizard for an existing connection (re-ingest)
    setIngesting({ id: conn.id, name: conn.name });
  }

  function handleStartReProfile(id: number) {
    const conn = connections.find((c) => c.id === id);
    if (conn) {
      // For re-profile, go straight to profiling (data is already ingested)
      setProfiling({ id, name: conn.name, startStream: true });
    }
  }

  function handleReProfileDone(_id: number) {
    // No-op — SSE banner handles completion internally
  }

  const contextPanel = (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-5 pb-3">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-3">Sources</p>
        <button
          onClick={() => { setEditingConn(null); setPanelConnector(CONNECTORS[0]); }}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-ocean text-white text-[13px] font-medium rounded-md hover:bg-ocean-hover transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New source
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin pb-2">
        <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted-2 px-4 py-1.5">Connected</p>
        {connections.map((conn) => {
          // A registry connection stores `type: 'duckdb'` with the real product
          // in `connector_type`, so keying off `type` alone drew a "?" avatar
          // over the caption "DUCKDB" for every Exact Online and Odoo source.
          // The product the user connected is the one to show.
          const productId = conn.connector_type ?? conn.type;
          const connector = connectorForType(productId) ?? connectorForType(conn.type);
          const mark = connectorMark(productId);
          return (
            <button
              key={conn.id}
              onClick={() => openEdit(conn)}
              className="w-full text-left flex items-center gap-2.5 px-4 py-2 border-l-2 border-transparent hover:bg-softer transition-colors"
            >
              {mark ? (
                <div
                  className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 border"
                  style={{ backgroundColor: `${mark.color}14`, borderColor: `${mark.color}2E` }}
                >
                  <svg viewBox={mark.viewBox} className="w-3.5 h-3.5" fill={mark.color} aria-hidden="true">
                    {mark.art}
                  </svg>
                </div>
              ) : (
                <div className={`w-7 h-7 rounded-md ${connector?.color ?? 'bg-softer'} text-white flex items-center justify-center text-[11px] font-medium shrink-0`}>
                  {connector?.iconLetter ?? productId.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <p className="text-[13px] text-ink-2 truncate leading-snug">{conn.name}</p>
                <p className="text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2 mt-0.5">
                  {connectorLabel(productId) ?? conn.type}
                </p>
              </div>
            </button>
          );
        })}
        {connections.length === 0 && !loading && (
          <p className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted-2 text-center mt-6 px-4">No sources yet</p>
        )}
      </div>
    </div>
  );

  const isEmptyFirstRun =
    !loading && connections.length === 0 && !ingesting && !profiling && !panelConnector;

  return (
    <AppShell
      title="Sources"
      subtitle={`${connections.length} source${connections.length !== 1 ? 's' : ''} connected`}
      contextPanel={isEmptyFirstRun ? undefined : contextPanel}
      pills={isEmptyFirstRun ? [] : [{ key: 'sources', label: 'Sources' }, { key: 'ingestion', label: 'Ingestion' }]}
      activePill={ingesting ? 'ingestion' : 'sources'}
      onPillChange={() => {}}
    >
      <div className="max-w-4xl mx-auto px-6 pt-10 pb-10 space-y-10">

        {/* Page header */}
        {!isEmptyFirstRun && (
          <header>
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">Connect</p>
            <h1 className="font-display text-[32px] text-ink leading-tight tracking-[-0.02em]">
              {connections.length} source{connections.length !== 1 ? 's' : ''} connected
            </h1>
          </header>
        )}

        {/* Ingestion wizard */}
        {ingesting && !profiling && (
          <IngestionWizard
            connectionId={ingesting.id}
            connectionName={ingesting.name}
            onIngestionDone={() => {
              setProfiling({ id: ingesting.id, name: ingesting.name, startStream: true });
              setIngesting(null);
            }}
            onSkip={() => {
              setProfiling({ id: ingesting.id, name: ingesting.name, startStream: true });
              setIngesting(null);
            }}
          />
        )}

        {/* Profiling banner */}
        {profiling && (
          <ProfilingBanner
            name={profiling.name}
            connId={profiling.id}
            startStream={profiling.startStream}
            onDismiss={() => { setProfiling(null); api.get('/connections').then((r) => setConnections(r.data.data ?? [])); }}
          />
        )}

        {/* "Try asking" call-out removed (2026-05-12): asking is the
            job of /ask, not the curation surface. Surfacing it on
            /sources blurred the IA — users would land here to manage
            connections and end up clicking into the chat instead. */}

        {/* Connected Sources */}
        <section>
          {!loading && connections.length > 0 && (
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-3">Connected Sources</p>
          )}

          {loading ? (
            <div className="bg-raised border border-line rounded-lg p-8 flex items-center justify-center">
              <div className="w-5 h-5 border-2 border-ocean border-t-transparent rounded-full animate-spin" />
            </div>
          ) : connections.length === 0 ? (
            <EmptyWorkspaceHero
              onConnect={() => {
                document.getElementById('add-source')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              onSample={() => {
                const sqlite = CONNECTORS.find((c) => c.id === 'sqlite');
                if (sqlite) { setEditingConn(null); setPanelConnector(sqlite); }
              }}
            />
          ) : (
            <div className="space-y-3">
              {connections.map((conn) => (
                <ConnectionCard
                  key={conn.id}
                  conn={conn}
                  onDelete={handleDelete}
                  onStartReProfile={handleStartReProfile}
                  onReProfileDone={handleReProfileDone}
                  onEdit={openEdit}
                  onReIngest={handleReIngest}
                  highlightedFromUrl={urlConnectionId === conn.id}
                  highlightedSchemaChangeId={urlConnectionId === conn.id ? urlSchemaChangeId ?? undefined : undefined}
                />
              ))}
            </div>
          )}
        </section>

        {/* Add a Source */}
        <section id="add-source" className="scroll-mt-6">
          <div className="mb-3">
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">Add a source</p>
            <p className="text-[13px] text-ink-3 leading-relaxed">Choose a connector to bring in your data.</p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {staticConnectors.map((connector) => (
              <ConnectorTile
                key={connector.id}
                connector={connector}
                onClick={() => { setEditingConn(null); setPanelConnector(connector); }}
              />
            ))}
            {registryConnectors.map((connector) => (
              <ConnectorTile
                key={`registry:${connector.id}`}
                connector={connector}
                onClick={() => router.push(`/sources/add-source?type=${encodeURIComponent(connector.id)}`)}
              />
            ))}
          </div>
        </section>
      </div>

      {/* Slide-in panel (create or edit) */}
      {panelConnector && (
        <SlidePanel
          connector={panelConnector}
          editConnection={editingConn ?? undefined}
          onClose={closePanel}
          onConnected={handleConnected}
          onUpdated={handleUpdated}
          isOAuth={editingIsOAuth}
          connectorType={editingConn?.connector_type ?? undefined}
        />
      )}
    </AppShell>
  );
}

export default function SourcesPage() {
  return (
    <RequireRole roles={['admin', 'analyst']}>
      <Suspense>
        <SourcesPageInner />
      </Suspense>
    </RequireRole>
  );
}
