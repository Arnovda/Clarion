'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import RequireRole from '@/components/RequireRole';
import IngestionWizard from '@/components/IngestionWizard';
import api from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
        placeholder: 'C:\\Users\\you\\Documents\\databridge\\data\\sample.db',
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
  {
    id: 'exactonline',
    name: 'Exact Online',
    description: 'Belgian & Dutch ERP platform',
    available: false,
    color: 'bg-teal-500',
    iconLetter: 'E',
    formFields: [],
  },
  {
    id: 'odoo',
    name: 'Odoo',
    description: 'Open-source ERP & CRM',
    available: false,
    color: 'bg-purple-500',
    iconLetter: 'O',
    formFields: [],
  },
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
// Helpers
// ---------------------------------------------------------------------------

function getConfig(conn: Connection): Record<string, string> {
  if (typeof conn.config === 'string') {
    try { return JSON.parse(conn.config); } catch { return {}; }
  }
  return (conn.config as Record<string, string>) ?? {};
}

function connectorForType(type: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === type);
}

// ---------------------------------------------------------------------------
// ConnectorIcon
// ---------------------------------------------------------------------------

function ConnectorIcon({ connector, size = 'md' }: { connector: Connector; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'w-8 h-8 text-sm', md: 'w-10 h-10 text-base', lg: 'w-12 h-12 text-lg' };
  return (
    <div className={`${sizes[size]} ${connector.color} rounded-lg flex items-center justify-center text-white font-bold shrink-0`}>
      {connector.iconLetter}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConnectionCard
// ---------------------------------------------------------------------------

function ConnectionCard({
  conn,
  onDelete,
  onStartReProfile,
  onReProfileDone,
  onEdit,
  onReIngest,
}: {
  conn: Connection;
  onDelete: (id: number) => void;
  onStartReProfile: (id: number) => void;
  onReProfileDone: (id: number) => void;
  onEdit: (conn: Connection) => void;
  onReIngest: (conn: Connection) => void;
}) {
  const router = useRouter();
  const connector = connectorForType(conn.type);
  const config = getConfig(conn);
  const [deleting, setDeleting] = useState(false);
  const [reprofiling, setReprofiling] = useState(false);

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

  return (
    <div className="bg-raised border border-line rounded-lg p-5 flex items-start gap-4 hover:border-line-strong transition-colors">
      {connector ? (
        <ConnectorIcon connector={connector} size="lg" />
      ) : (
        <div className="w-12 h-12 bg-softer border border-line rounded-md flex items-center justify-center text-muted font-medium shrink-0">?</div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[14px] font-medium text-ink">{conn.name}</span>
          <span className="px-2 py-0.5 rounded border border-line text-[10px] font-mono tracking-[0.08em] uppercase bg-ok-soft text-ok">Connected</span>
          {conn.query_engine === 'duckdb' ? (
            <span className="px-2 py-0.5 rounded border border-line text-[10px] font-mono tracking-[0.08em] uppercase bg-ai-soft text-ai">Delta Lake</span>
          ) : (
            <span className="px-2 py-0.5 rounded border border-line text-[10px] font-mono tracking-[0.08em] uppercase bg-softer text-muted">Source</span>
          )}
        </div>
        <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted-2 mb-1">{conn.type}</p>
        {config.filepath && (
          <p className="text-[11px] text-ink-3 font-mono truncate" title={config.filepath}>{config.filepath}</p>
        )}
        {(config as Record<string, unknown>).host && (
          <p className="text-[11px] text-ink-3 font-mono truncate">
            {(config as Record<string, unknown>).host}:{(config as Record<string, unknown>).port ?? ''}
            {(config as Record<string, unknown>).database ? ` / ${(config as Record<string, unknown>).database}` : ''}
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
        </p>
      </div>
      <div className="flex flex-col gap-1 shrink-0">
        <button
          onClick={() => router.push(`/semantic?connectionId=${conn.id}`)}
          className="px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
        >
          View definitions
        </button>
        <button
          onClick={() => onEdit(conn)}
          className="px-3 py-1.5 text-[12px] bg-raised border border-line text-ink-2 rounded-md hover:bg-softer hover:border-line-strong transition-colors"
        >
          Edit
        </button>
        <button
          onClick={() => onReIngest(conn)}
          className="px-3 py-1.5 text-[12px] bg-ai-soft text-ai border border-line rounded-md hover:bg-ai/15 transition-colors"
        >
          Re-ingest
        </button>
        <button
          onClick={handleReProfile}
          disabled={reprofiling}
          className="px-3 py-1.5 text-[12px] bg-raised border border-line text-ink-2 rounded-md hover:bg-softer hover:border-line-strong transition-colors disabled:opacity-50"
        >
          {reprofiling ? 'Re-analysing…' : 'Re-analyse'}
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="px-3 py-1.5 text-[12px] bg-err-soft text-err border border-line rounded-md hover:bg-err/15 transition-colors disabled:opacity-50"
        >
          {deleting ? 'Removing…' : 'Remove'}
        </button>
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
}: {
  connector: Connector;
  editConnection?: Connection;        // present → edit mode
  onClose: () => void;
  onConnected: (id: number, name: string) => void;
  onUpdated: (conn: Connection) => void;
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
        await api.patch(`/connections/${editConnection!.id}`, {
          name: name.trim(),
          config: normalizedCfg,
          domains,
        });
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
              <p>1. DataBridge tests the connection to make sure it works.</p>
              <p>2. You pick which tables to ingest into the data warehouse.</p>
              <p>3. Data is ingested as Delta Lake tables for fast querying.</p>
              <p>4. The schema is profiled and Claude generates definitions for your review.</p>
            </div>
          )}
          {isEdit && (
            <div className="bg-warn-soft border border-line rounded-md p-4 text-[12px] text-ink-2 space-y-1 leading-relaxed">
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-warn mb-1">Changing connection details?</p>
              <p>Test the connection first, then save. If you point to a different database, use Re-analyse to regenerate definitions.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-line flex gap-2">
          <button
            onClick={handleTest}
            disabled={!allFilled || testStatus === 'testing'}
            className="px-4 py-2 text-[13px] bg-raised border border-line rounded-md hover:bg-softer hover:border-line-strong disabled:opacity-40 transition-colors text-ink-2"
          >
            {testStatus === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
          <button
            onClick={handleSave}
            disabled={testStatus !== 'ok' || saving}
            className="flex-1 px-4 py-2 text-[13px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-40 transition-colors"
          >
            {saving
              ? (isEdit ? 'Saving…' : 'Saving & analysing…')
              : (isEdit ? 'Save changes' : 'Save & analyse')}
          </button>
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

  useEffect(() => {
    if (!startStream || !connId) return;

    const token = typeof window !== 'undefined' ? localStorage.getItem('databridge_token') : null;
    const abortCtrl = new AbortController();

    (async () => {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'}/connections/${connId}/profile`, {
          method: 'POST',
          headers: {
            'Accept': 'text/event-stream',
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
          },
          signal: abortCtrl.signal,
        });

        if (!res.ok || !res.body) {
          let detail = `HTTP ${res.status}`;
          try { detail = await res.text(); } catch { /* ignore */ }
          console.error('[ProfilingBanner] stream failed:', res.status, detail);
          setError(`Failed to start profiling stream (${res.status})`);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6));
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
            } catch { /* skip unparseable */ }
          }
        }
        // Stream ended without explicit done/error — the connection was
        // likely lost (container restart, network timeout). Poll DB status
        // to find out what actually happened instead of assuming success.
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
              // Still running — connection dropped, switch to polling mode
              setError('Connection to server lost — refresh to check progress');
            }
          } catch {
            setError('Connection to server lost');
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError('Connection to server lost');
        }
      }
    })();

    return () => abortCtrl.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startStream, connId]);

  // Poll for profiling status when banner is shown without a live stream
  // (e.g. user navigated away and came back while profiling was running)
  useEffect(() => {
    if (startStream || !connId) return; // SSE is active, no need to poll
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
  }, [startStream, connId]);

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
          Connect a source and DataBridge will profile it, learn what every column means,
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
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [panelConnector, setPanelConnector] = useState<Connector | null>(null);
  const [editingConn, setEditingConn] = useState<Connection | null>(null);
  const [profiling, setProfiling] = useState<{ id: number; name: string; startStream?: boolean } | null>(null);
  const [ingesting, setIngesting] = useState<{ id: number; name: string } | null>(null);

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

  function openEdit(conn: Connection) {
    const connector = connectorForType(conn.type);
    if (!connector) return;
    setEditingConn(conn);
    setPanelConnector(connector);
  }

  function closePanel() {
    setPanelConnector(null);
    setEditingConn(null);
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
          const connector = connectorForType(conn.type);
          return (
            <button
              key={conn.id}
              onClick={() => openEdit(conn)}
              className="w-full text-left flex items-center gap-2.5 px-4 py-2 border-l-2 border-transparent hover:bg-softer transition-colors"
            >
              <div className={`w-7 h-7 rounded-md ${connector?.color ?? 'bg-softer'} text-white flex items-center justify-center text-[11px] font-medium shrink-0`}>
                {connector?.iconLetter ?? '?'}
              </div>
              <div className="min-w-0">
                <p className="text-[13px] text-ink-2 truncate leading-snug">{conn.name}</p>
                <p className="text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2 mt-0.5">{conn.type}</p>
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
      title="Connect"
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
            {CONNECTORS.map((connector) => (
              <ConnectorTile
                key={connector.id}
                connector={connector}
                onClick={() => { setEditingConn(null); setPanelConnector(connector); }}
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
        />
      )}
    </AppShell>
  );
}

export default function SourcesPage() {
  return (
    <RequireRole roles={['admin', 'analyst']}>
      <SourcesPageInner />
    </RequireRole>
  );
}
