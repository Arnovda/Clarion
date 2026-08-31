'use client';

/**
 * "Add a source" wizard — drives the new connector platform.
 *
 * Three steps:
 *   1. Pick a source type      — fetched from GET /api/source-types
 *   2. Configure credentials   — form auto-rendered from the connector's
 *                                JSON Schema; "Test connection" calls
 *                                POST /api/source-types/:type/test
 *   3. Pick entities           — multi-select from
 *                                POST /api/source-types/:type/list-entities
 *
 * Save → POST /api/connections/source → redirect to /catalog.
 *
 * The wizard is connector-agnostic. Adding a new connector to the registry
 * (backend) makes it appear in step 1 with no frontend change required —
 * its form fields are derived from the JSON Schema, its entities are
 * loaded by the connector's listEntities method.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, Loader2, Plug, X } from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import RequireRole from '@/components/RequireRole';
import api from '@/lib/api';
import { cn } from '@/lib/cn';

// ─── Backend types (mirror @databridge/connectors) ────────────────────────
interface SourceTypeMeta {
  type: string;
  displayName: string;
  iconSvg?: string;
  configSchema: JsonSchemaObject;
  egressAllowList: string[];
  /** When set, the wizard renders a "Connect with X" button instead of asking for paste tokens. */
  oauth?: { preAuthFields: string[] };
}

interface JsonSchemaObject {
  type: 'object';
  required?: string[];
  properties: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean;
}

interface JsonSchemaProperty {
  type: 'string' | 'integer' | 'number' | 'boolean';
  title?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /**
   * Draft-07's standard way for a schema to say "this string is a
   * base64-encoded file". A property carrying it renders as a file picker
   * rather than a text box, which is what lets a file-backed connector need
   * no frontend code of its own.
   */
  contentEncoding?: 'base64';
  /** MIME type the picker should accept, when the schema names one. */
  contentMediaType?: string;
}

interface EntityDescriptor {
  name: string;
  displayName?: string;
  category?: string;
  description?: string;
  estimatedRowCount?: number;
  supportsIncremental: boolean;
  // ─── Probe-before-pick fields ──────────────────────────────────────────
  // Populated when the backend returned `supportsProbe: true`. The wizard
  // uses these to render forbidden entries as disabled (with reason),
  // hide 404s, and badge available entries with a row-sample hint.
  state?: 'available' | 'forbidden' | 'not_found' | 'error';
  rowCountSample?: number;
  reason?: string;
}

interface TestResult {
  ok: boolean;
  error?: string;
  details?: Record<string, string>;
}

type Step = 'pick-type' | 'configure' | 'pick-entities' | 'saving';

// ─── Page ─────────────────────────────────────────────────────────────────
export default function AddSourcePage() {
  return (
    <RequireRole roles={['admin']}>
      <AppShell>
        <AddSourceWizard />
      </AppShell>
    </RequireRole>
  );
}

function AddSourceWizard() {
  const router = useRouter();
  // When the user clicks a connector tile on /sources, we route here with
  // ?type=<id>. The wizard skips the type-picker step and goes straight
  // to the configure form.
  const searchParams = useSearchParams();
  const preselectedType = searchParams.get('type');

  // Wizard state
  const [step, setStep] = useState<Step>('pick-type');
  const [types, setTypes] = useState<SourceTypeMeta[]>([]);
  const [loadingTypes, setLoadingTypes] = useState(true);
  const [pickedType, setPickedType] = useState<SourceTypeMeta | null>(null);
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [entities, setEntities] = useState<EntityDescriptor[]>([]);
  const [loadingEntities, setLoadingEntities] = useState(false);
  const [selectedEntities, setSelectedEntities] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  // OAuth-flow state. When the user clicks "Connect with X" we get back a
  // stateToken; subsequent test/list-entities/save calls reference it instead
  // of inline `config`. The refresh_token never leaves the backend.
  const [oauthStateToken, setOauthStateToken] = useState<string | null>(null);
  const [oauthInProgress, setOauthInProgress] = useState(false);

  // Load source-types catalog on mount. If a `?type=` was provided, jump
  // straight to step 2 once the catalog is in.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api.get('/source-types');
        if (!active) return;
        const catalog: SourceTypeMeta[] = res.data?.data ?? [];
        setTypes(catalog);
        if (preselectedType) {
          const match = catalog.find((t) => t.type === preselectedType);
          if (match) {
            handlePickType(match);
          }
        }
      } catch (err) {
        console.error('failed to load source-types', err);
      } finally {
        if (active) setLoadingTypes(false);
      }
    })();
    return () => { active = false; };
    // `preselectedType` and `handlePickType` are intentionally omitted —
    // we only want this to run once at mount; the closure captures the
    // initial `preselectedType` value, which is what we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-fill default name when a type is picked
  function handlePickType(t: SourceTypeMeta) {
    setPickedType(t);
    setName((current) => current || t.displayName);
    // Apply schema defaults
    const defaults: Record<string, unknown> = {};
    for (const [k, prop] of Object.entries(t.configSchema.properties)) {
      if (prop.default !== undefined) defaults[k] = prop.default;
    }
    setConfig(defaults);
    setTestResult(null);
    setStep('configure');
  }

  /** Body for /test, /list-entities, and /connections/source — inline config OR oauthStateToken. */
  function probeBody(): { config?: Record<string, unknown>; oauthStateToken?: string } {
    return oauthStateToken ? { oauthStateToken } : { config };
  }

  async function handleTest() {
    if (!pickedType) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.post(`/source-types/${pickedType.type}/test`, probeBody());
      setTestResult(res.data?.data ?? { ok: false, error: 'Empty response' });
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })
        ?.response?.data?.error
        ?? (err as Error)?.message
        ?? 'Network error';
      setTestResult({ ok: false, error: msg });
    } finally {
      setTesting(false);
    }
  }

  /**
   * OAuth Authorization Code flow.
   * 1. POST /oauth-init with the user's pre-auth fields → get { authUrl, stateToken }
   * 2. Open authUrl in a popup window.
   * 3. Listen for postMessage from the callback page (kind === 'clarion:oauth').
   * 4. On success message, POST /oauth-finish with { stateToken, code } — backend
   *    exchanges the code for tokens and updates the pending row.
   * 5. Stash stateToken in component state; subsequent calls send it instead of `config`.
   * 6. Auto-run testConnection so the user sees ✓ Connected before moving on.
   *
   * The refresh_token never reaches the browser — it's exchanged backend-side
   * and stored encrypted. Only the stateToken (an opaque pointer) is in the
   * wizard's memory.
   */
  async function handleOAuthConnect() {
    if (!pickedType?.oauth) return;
    setOauthInProgress(true);
    setTestResult(null);
    try {
      const initRes = await api.post(
        `/source-types/${pickedType.type}/oauth-init`,
        { config },
      );
      const data = initRes.data?.data as { authUrl: string; stateToken: string } | undefined;
      if (!data?.authUrl || !data?.stateToken) {
        throw new Error('oauth-init returned an unexpected response');
      }

      // Open popup. Centred 600x700 over current window.
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

      // Listen on a BroadcastChannel for the result. Two reasons:
      //   1. window.opener.postMessage doesn't work — once the popup
      //      passes through a third-party auth screen with strict COOP
      //      (ExactOnline does this), the opener link is severed even if
      //      the popup ends up back on our origin.
      //   2. BroadcastChannel is same-origin and works between any
      //      tabs/windows on our origin, regardless of opener state.
      //
      // We also keep a window.message listener as a fallback for browsers
      // that don't support BroadcastChannel (none in our supported matrix,
      // but it's a cheap safety net).
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

        // If the user closes the popup without completing, error out.
        // 1.5s grace period after popup.closed so the channel message has
        // time to land — popup.close() fires after the message is queued
        // but the wizard sees `closed` immediately.
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

      if (!result.ok) {
        throw new Error(result.error ?? 'OAuth authorization failed');
      }
      if (result.state !== data.stateToken) {
        // CSRF guard — the state we got back should match what we issued.
        throw new Error('OAuth state mismatch');
      }

      // Hand the code back to the backend to complete the exchange.
      await api.post(`/source-types/${pickedType.type}/oauth-finish`, {
        stateToken: data.stateToken,
        code: result.code,
      });

      setOauthStateToken(data.stateToken);
      // We DON'T fire testConnection here — the OAuth exchange already
      // proved the credentials are valid (it minted access + refresh tokens),
      // and an immediate refresh would hit EO's "access_token not expired"
      // rate limit. Just synthesise a success state for the UI; the next
      // step (list-entities) will exercise the access token end-to-end.
      setTestResult({ ok: true, details: {} });
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })
        ?.response?.data?.error
        ?? (err as Error)?.message
        ?? 'OAuth flow failed';
      setTestResult({ ok: false, error: msg });
    } finally {
      setOauthInProgress(false);
    }
  }

  async function handleProceedToEntities() {
    if (!pickedType) return;
    setLoadingEntities(true);
    try {
      // probe-entities returns the same shape as list-entities (one row
      // per catalogued entity with displayName / category / description)
      // PLUS per-entity availability flags (state / rowCountSample /
      // reason). For connectors that don't implement probeEntities, the
      // backend defaults every state to 'available' — current behaviour
      // preserved, no special-casing needed on the frontend.
      const res = await api.post(`/source-types/${pickedType.type}/probe-entities`, probeBody());
      setEntities(res.data?.data ?? []);
      setStep('pick-entities');
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })
        ?.response?.data?.error
        ?? (err as Error)?.message
        ?? 'Failed to verify available entities';
      setTestResult({ ok: false, error: msg });
    } finally {
      setLoadingEntities(false);
    }
  }

  async function handleSave() {
    if (!pickedType) return;
    if (selectedEntities.size === 0) {
      setSaveError('Pick at least one entity to sync.');
      return;
    }
    setSaveError(null);
    setStep('saving');
    try {
      const res = await api.post('/connections/source', {
        name: name.trim() || pickedType.displayName,
        connectorType: pickedType.type,
        // OAuth flow: backend reads the full config from oauth_pending via stateToken.
        // Paste-token flow: send config inline.
        ...(oauthStateToken ? { oauthStateToken } : { config }),
        selectedEntities: Array.from(selectedEntities),
      });
      const id = res.data?.data?.connectionId;
      if (id) {
        router.push(`/catalog`);
      } else {
        setSaveError('Connection saved but no ID returned.');
        setStep('pick-entities');
      }
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })
        ?.response?.data?.error
        ?? (err as Error)?.message
        ?? 'Save failed';
      setSaveError(msg);
      setStep('pick-entities');
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header ───────────────────────────────────────────────────────── */}
      <div className="border-b border-line bg-raised px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div>
          <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-0.5">
            Setup
          </p>
          <h1 className="font-display text-[22px] text-ink leading-tight tracking-[-0.02em]">
            Add a source
          </h1>
        </div>
        <button
          onClick={() => router.push('/sources')}
          className="text-[12.5px] text-muted hover:text-ink flex items-center gap-1.5"
        >
          <X className="w-4 h-4" /> Cancel
        </button>
      </div>

      {/* Step indicator ───────────────────────────────────────────────── */}
      <StepIndicator step={step} />

      {/* Body ────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-bg">
        <div className="max-w-3xl mx-auto px-6 py-8">
          {step === 'pick-type' && (
            <PickType types={types} loading={loadingTypes} onPick={handlePickType} />
          )}
          {step === 'configure' && pickedType && (
            <Configure
              type={pickedType}
              name={name}
              setName={setName}
              config={config}
              setConfig={setConfig}
              testing={testing}
              testResult={testResult}
              onTest={handleTest}
              onBack={() => setStep('pick-type')}
              onNext={handleProceedToEntities}
              loadingEntities={loadingEntities}
              oauthStateToken={oauthStateToken}
              oauthInProgress={oauthInProgress}
              onOAuthConnect={handleOAuthConnect}
            />
          )}
          {step === 'pick-entities' && pickedType && (
            <PickEntities
              entities={entities}
              selected={selectedEntities}
              setSelected={setSelectedEntities}
              onBack={() => setStep('configure')}
              onSave={handleSave}
              saveError={saveError}
            />
          )}
          {step === 'saving' && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <Loader2 className="w-6 h-6 animate-spin text-ocean mb-4" strokeWidth={2} />
              <p className="text-[13px] text-ink">Saving connection…</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Step indicator ───────────────────────────────────────────────────────
function StepIndicator({ step }: { step: Step }) {
  const stepNum = step === 'pick-type' ? 1 : step === 'configure' ? 2 : 3;
  const labels = ['Pick a source', 'Configure', 'Choose entities'];
  return (
    <div className="bg-raised border-b border-line px-6 py-3 flex-shrink-0">
      <div className="max-w-3xl mx-auto flex items-center gap-3">
        {labels.map((label, i) => (
          <div key={label} className="flex items-center gap-3 flex-1">
            <div
              className={cn(
                'w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-medium border transition-colors',
                i + 1 < stepNum && 'bg-ocean text-white border-ocean',
                i + 1 === stepNum && 'bg-ocean-softer text-ocean border-ocean',
                i + 1 > stepNum && 'bg-bg text-muted border-line',
              )}
            >
              {i + 1 < stepNum ? <Check className="w-3 h-3" strokeWidth={2.5} /> : i + 1}
            </div>
            <span
              className={cn(
                'text-[12px] font-mono uppercase tracking-[0.06em]',
                i + 1 === stepNum ? 'text-ink' : 'text-muted',
              )}
            >
              {label}
            </span>
            {i < labels.length - 1 && <div className="flex-1 h-px bg-line" />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Step 1: pick a type ──────────────────────────────────────────────────
function PickType(props: {
  types: SourceTypeMeta[];
  loading: boolean;
  onPick: (t: SourceTypeMeta) => void;
}) {
  if (props.loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Loader2 className="w-6 h-6 animate-spin text-ocean mb-4" strokeWidth={2} />
        <p className="text-[13px] text-muted">Loading available sources…</p>
      </div>
    );
  }
  if (props.types.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-[13px] text-muted">No source connectors registered.</p>
      </div>
    );
  }
  return (
    <div>
      <p className="text-[13px] text-ink-2 mb-6">
        Choose what you'd like to connect. The form on the next step is generated from
        the connector's own schema — different sources ask for different fields.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {props.types.map((t) => (
          <button
            key={t.type}
            onClick={() => props.onPick(t)}
            className="text-left p-4 rounded-md border border-line bg-raised hover:border-ocean hover:bg-ocean-softer/30 transition-colors flex items-start gap-3"
          >
            <div className="w-9 h-9 rounded-md bg-ocean-softer text-ocean flex items-center justify-center flex-shrink-0">
              {t.iconSvg ? (
                <span dangerouslySetInnerHTML={{ __html: t.iconSvg }} />
              ) : (
                <Plug className="w-4 h-4" strokeWidth={1.75} />
              )}
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-ink truncate">{t.displayName}</p>
              <p className="text-[11px] font-mono text-muted-2 mt-0.5">{t.type}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Step 2: configure ────────────────────────────────────────────────────
function Configure(props: {
  type: SourceTypeMeta;
  name: string;
  setName: (s: string) => void;
  config: Record<string, unknown>;
  setConfig: (c: Record<string, unknown>) => void;
  testing: boolean;
  testResult: TestResult | null;
  onTest: () => void;
  onBack: () => void;
  onNext: () => void;
  loadingEntities: boolean;
  oauthStateToken: string | null;
  oauthInProgress: boolean;
  onOAuthConnect: () => void;
}) {
  // When the connector supports OAuth, only pre-auth fields are shown in the
  // form — refresh_token etc. are filled in by the OAuth dance.
  const isOAuth = !!props.type.oauth;
  const oauthDone = !!props.oauthStateToken;
  const visibleFieldKeys = useMemo(() => {
    const all = Object.keys(props.type.configSchema.properties);
    if (!isOAuth) return all;
    const preAuth = new Set(props.type.oauth!.preAuthFields);
    return all.filter((k) => preAuth.has(k));
  }, [isOAuth, props.type]);

  const visibleSchema = useMemo<JsonSchemaObject>(() => {
    if (!isOAuth) return props.type.configSchema;
    const filteredProps: Record<string, JsonSchemaProperty> = {};
    for (const k of visibleFieldKeys) {
      filteredProps[k] = props.type.configSchema.properties[k];
    }
    return {
      type: 'object',
      required: (props.type.configSchema.required ?? []).filter((k) => visibleFieldKeys.includes(k)),
      properties: filteredProps,
    };
  }, [isOAuth, props.type.configSchema, visibleFieldKeys]);

  const required = useMemo(
    () => new Set(visibleSchema.required ?? []),
    [visibleSchema],
  );
  const allRequiredFilled = useMemo(() => {
    return Array.from(required).every((k) => {
      const v = props.config[k];
      return v !== undefined && v !== null && v !== '';
    });
  }, [props.config, required]);

  function setField(key: string, value: unknown) {
    props.setConfig({ ...props.config, [key]: value });
  }

  return (
    <div>
      <h2 className="font-display text-[20px] text-ink leading-tight tracking-[-0.01em] mb-1">
        Configure {props.type.displayName}
      </h2>
      <p className="text-[13px] text-ink-3 mb-6">
        {isOAuth
          ? 'Fill in your app registration details, then click Connect — you\'ll be redirected to ' +
            props.type.displayName + ' to authorize.'
          : 'These credentials are encrypted at rest. You can change them later by re-running this wizard.'}
      </p>

      {/* Connection name */}
      <div className="mb-5">
        <label className="block text-[11px] font-mono uppercase tracking-[0.06em] text-muted mb-1.5">
          Connection name
        </label>
        <input
          type="text"
          value={props.name}
          onChange={(e) => props.setName(e.target.value)}
          placeholder={props.type.displayName}
          className="w-full px-3 py-2 text-[13px] border border-line rounded-md bg-bg focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
        />
        <p className="text-[11px] text-muted-2 mt-1">
          A label to recognise this connection in the UI.
        </p>
      </div>

      {/* Auto-generated form. In OAuth mode, only pre-auth fields are shown. */}
      <SchemaForm
        schema={visibleSchema}
        value={props.config}
        onChange={setField}
      />

      {/* Test connection / Connect-with-OAuth */}
      <div className="mt-6 pt-6 border-t border-line">
        {isOAuth ? (
          <button
            onClick={props.onOAuthConnect}
            disabled={props.oauthInProgress || !allRequiredFilled || oauthDone}
            className="px-4 py-2 text-[13px] bg-ocean text-white font-medium rounded-md hover:bg-ocean-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {props.oauthInProgress ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
            ) : oauthDone ? (
              <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
            ) : (
              <Plug className="w-3.5 h-3.5" strokeWidth={2} />
            )}
            {props.oauthInProgress
              ? 'Waiting for authorization…'
              : oauthDone
                ? 'Connected — click Continue'
                : `Connect with ${props.type.displayName}`}
          </button>
        ) : (
          <button
            onClick={props.onTest}
            disabled={props.testing || !allRequiredFilled}
            className="px-4 py-2 text-[13px] border border-line rounded-md hover:border-ocean hover:bg-ocean-softer/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {props.testing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Plug className="w-3.5 h-3.5" strokeWidth={2} />
            )}
            {props.testing ? 'Testing…' : 'Test connection'}
          </button>
        )}
        {props.testResult && (
          <div
            className={cn(
              'mt-3 px-3 py-2 rounded-md border text-[12.5px]',
              props.testResult.ok
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-rose-50 border-rose-200 text-rose-900',
            )}
          >
            {props.testResult.ok ? (
              <div className="flex items-start gap-2">
                <Check className="w-4 h-4 flex-shrink-0 mt-0.5" strokeWidth={2.5} />
                <div>
                  <p className="font-medium">Connection successful</p>
                  {props.testResult.details && Object.keys(props.testResult.details).length > 0 && (
                    <p className="text-[11.5px] mt-1 font-mono text-emerald-800">
                      {Object.entries(props.testResult.details)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' · ')}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <X className="w-4 h-4 flex-shrink-0 mt-0.5" strokeWidth={2.5} />
                <div>
                  <p className="font-medium">Connection failed</p>
                  <p className="text-[11.5px] mt-1 break-words">{props.testResult.error}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer nav */}
      <div className="mt-8 flex items-center justify-between">
        <button
          onClick={props.onBack}
          className="text-[13px] text-muted hover:text-ink flex items-center gap-1.5"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>
        <button
          onClick={props.onNext}
          disabled={!props.testResult?.ok || props.loadingEntities}
          className="px-4 py-2 bg-ocean text-white text-[13px] font-medium rounded-md hover:bg-ocean-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
        >
          {props.loadingEntities && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />}
          {props.loadingEntities ? 'Loading entities…' : 'Continue'}
          {!props.loadingEntities && <ArrowRight className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

// ─── Auto-form renderer ───────────────────────────────────────────────────
/**
 * Minimal JSON Schema form renderer — handles flat objects with string /
 * enum properties (which is everything our connector configs need today).
 *
 * We didn't pull in @rjsf because:
 *   • Bundle size is significant for what we use of it
 *   • Theming it to match Observatory tokens is non-trivial
 *   • Our schemas are tiny — 5–8 fields each — and don't need rjsf's full power
 *
 * If schemas grow more complex (nested objects, arrays of structured data,
 * conditional fields) swap in rjsf at that point.
 */
function SchemaForm(props: {
  schema: JsonSchemaObject;
  value: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const required = new Set(props.schema.required ?? []);
  return (
    <div className="space-y-4">
      {Object.entries(props.schema.properties).map(([key, prop]) => (
        <SchemaField
          key={key}
          fieldKey={key}
          prop={prop}
          required={required.has(key)}
          value={props.value[key]}
          onChange={(v) => props.onChange(key, v)}
          onChangeField={props.onChange}
        />
      ))}
    </div>
  );
}

function SchemaField(props: {
  fieldKey: string;
  prop: JsonSchemaProperty;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Set a sibling field — the file picker fills in the file name too. */
  onChangeField: (key: string, value: unknown) => void;
}) {
  const { fieldKey, prop, required, value, onChange, onChangeField } = props;
  // Sensitive field detection — render as <input type="password">.
  // Field-name based; backend already enforces redaction in logs.
  const isSensitive = /(secret|password|token|apikey|api_key)/i.test(fieldKey);
  const label = prop.title ?? humanise(fieldKey);

  // A base64 property is a file, not a string somebody types.
  if (prop.contentEncoding === 'base64') {
    return (
      <FileField
        fieldKey={fieldKey}
        prop={prop}
        required={required}
        value={value}
        onChange={onChange}
        onChangeField={onChangeField}
      />
    );
  }

  // A boolean is a checkbox. Without this it fell through to the text input
  // below and the user typed the word "true" into a boolean field.
  if (prop.type === 'boolean') {
    const checked = value === undefined || value === null ? prop.default === true : value === true;
    return (
      <div>
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-line text-ocean focus:ring-1 focus:ring-ocean/30"
          />
          <span>
            <span className="block text-[13px] text-ink">{label}</span>
            {prop.description && (
              <span className="block text-[11px] text-muted-2 mt-0.5">{prop.description}</span>
            )}
          </span>
        </label>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-[11px] font-mono uppercase tracking-[0.06em] text-muted mb-1.5">
        {label}
        {required && <span className="text-rose-500 ml-1">*</span>}
      </label>
      {prop.enum ? (
        <select
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 text-[13px] border border-line rounded-md bg-bg focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
        >
          {!required && <option value="">— select —</option>}
          {prop.enum.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      ) : (
        <input
          type={isSensitive ? 'password' : prop.type === 'integer' || prop.type === 'number' ? 'number' : 'text'}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            if (prop.type === 'integer' || prop.type === 'number') {
              onChange(raw === '' ? '' : Number(raw));
            } else {
              onChange(raw);
            }
          }}
          autoComplete="off"
          spellCheck={false}
          placeholder={prop.default !== undefined ? String(prop.default) : ''}
          className="w-full px-3 py-2 text-[13px] border border-line rounded-md bg-bg focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 font-mono"
        />
      )}
      {prop.description && (
        <p className="text-[11px] text-muted-2 mt-1">{prop.description}</p>
      )}
    </div>
  );
}

/**
 * File picker for a schema property declared as base64.
 *
 * Reads the file in the browser and puts its base64 into the config, so the
 * upload rides the ordinary connection-create request — there is no separate
 * upload endpoint to keep in step, and the bytes are encrypted at rest with
 * the rest of the connector config.
 *
 * The size check happens HERE as well as in the connector's schema, on
 * purpose. Server-side validation is what makes it safe; this check is what
 * makes it kind — a 40 MB workbook fails in the picker with a sentence about
 * the file, instead of after a long upload with a 413.
 */
function FileField(props: {
  fieldKey: string;
  prop: JsonSchemaProperty;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  onChangeField: (key: string, value: unknown) => void;
}) {
  const { prop, required, value, onChange, onChangeField } = props;
  const [name, setName] = useState<string>('');
  const [size, setSize] = useState<number>(0);
  const [error, setError] = useState<string>('');
  const label = prop.title ?? humanise(props.fieldKey);

  // maxLength bounds the BASE64 string, so the byte ceiling is three quarters
  // of it. Deriving it here keeps one number in the schema instead of two that
  // can drift apart.
  const maxBytes = prop.maxLength ? Math.floor((prop.maxLength / 4) * 3) : undefined;

  async function pick(file: File | undefined) {
    if (!file) return;
    setError('');
    if (maxBytes && file.size > maxBytes) {
      setError(
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is `
        + `${Math.round(maxBytes / 1024 / 1024)} MB — split the file, or load this data from a database instead.`,
      );
      onChange('');
      setName('');
      setSize(0);
      return;
    }
    try {
      const base64 = await readAsBase64(file);
      onChange(base64);
      setName(file.name);
      setSize(file.size);
      // Fill the sibling that names the file, so the catalog can tell two
      // spreadsheet sources apart without the user typing the name twice.
      onChangeField('filename', file.name);
    } catch {
      setError('That file could not be read. Try selecting it again.');
    }
  }

  const chosen = typeof value === 'string' && value.length > 0;

  return (
    <div>
      <label className="block text-[11px] font-mono uppercase tracking-[0.06em] text-muted mb-1.5">
        {label}
        {required && <span className="text-rose-500 ml-1">*</span>}
      </label>
      <input
        type="file"
        accept=".xlsx,.xlsm"
        onChange={(e) => void pick(e.target.files?.[0])}
        className="w-full text-[13px] text-ink file:mr-3 file:rounded-md file:border-0 file:bg-ocean file:px-3 file:py-2 file:text-[12px] file:font-medium file:text-white hover:file:bg-ocean/90 cursor-pointer"
      />
      {chosen && name && (
        <p className="text-[11px] text-muted mt-1.5 font-mono">
          {name} · {(size / 1024).toFixed(0)} KB
        </p>
      )}
      {error && <p className="text-[11px] text-rose-600 mt-1.5">{error}</p>}
      {prop.description && !error && (
        <p className="text-[11px] text-muted-2 mt-1">{prop.description}</p>
      )}
    </div>
  );
}

/** Read a File into base64, without the `data:` prefix the reader adds. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function humanise(key: string): string {
  // 'clientId' → 'Client id'; 'refresh_token' → 'Refresh token'.
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

// ─── Step 3: pick entities ────────────────────────────────────────────────
function PickEntities(props: {
  entities: EntityDescriptor[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onBack: () => void;
  onSave: () => void;
  saveError: string | null;
}) {
  // Probe-before-pick filtering:
  //   - 'not_found' entries are HIDDEN entirely (path bug; not user-fixable)
  //   - 'forbidden' entries are SHOWN but disabled (module not licensed)
  //   - 'error' entries are SHOWN but disabled (transient — wizard retry later)
  //   - 'available' is the normal selectable case
  // We compute counts for the summary line so users see both pickable +
  // un-pickable populations.
  const visibleEntities = useMemo(
    () => props.entities.filter((e) => (e.state ?? 'available') !== 'not_found'),
    [props.entities],
  );
  const pickableEntities = useMemo(
    () => visibleEntities.filter((e) => (e.state ?? 'available') === 'available'),
    [visibleEntities],
  );
  const forbiddenCount = visibleEntities.length - pickableEntities.length;
  const hiddenCount = props.entities.length - visibleEntities.length;

  function isPickable(e: EntityDescriptor): boolean {
    return (e.state ?? 'available') === 'available';
  }

  // Group by category for browsability with large catalogs.
  const grouped = useMemo(() => {
    const m = new Map<string, EntityDescriptor[]>();
    for (const e of visibleEntities) {
      const k = e.category ?? 'Other';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [visibleEntities]);

  function toggle(name: string) {
    const e = props.entities.find((x) => x.name === name);
    if (e && !isPickable(e)) return;  // ignore clicks on disabled rows
    const next = new Set(props.selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    props.setSelected(next);
  }

  function selectAllInGroup(items: EntityDescriptor[]) {
    const next = new Set(props.selected);
    // Only select the pickable ones — don't drag in forbidden entries.
    for (const e of items) if (isPickable(e)) next.add(e.name);
    props.setSelected(next);
  }

  function clearAll() {
    props.setSelected(new Set());
  }

  return (
    <div>
      <h2 className="font-display text-[20px] text-ink leading-tight tracking-[-0.01em] mb-1">
        Choose entities to sync
      </h2>
      <p className="text-[13px] text-ink-3 mb-6">
        These are the tables we'll pull on each sync. You can change the selection later.
      </p>

      <div className="flex items-center justify-between mb-4 text-[12px]">
        <span className="text-muted">
          <span className="text-ink font-medium">{props.selected.size}</span>
          {' '}of {pickableEntities.length} selectable
          {forbiddenCount > 0 && (
            <span className="text-muted-2"> · {forbiddenCount} not available</span>
          )}
          {hiddenCount > 0 && (
            <span className="text-muted-2"> · {hiddenCount} hidden</span>
          )}
        </span>
        <button
          onClick={clearAll}
          disabled={props.selected.size === 0}
          className="text-muted hover:text-ink disabled:opacity-50"
        >
          Clear
        </button>
      </div>

      {(forbiddenCount > 0 || hiddenCount > 0) && (
        <div className="mb-4 px-3 py-2 rounded-md border border-line bg-softer text-[12px] text-muted">
          We checked your connection. Items shown with a lock aren&apos;t accessible
          {' '}from your Exact Online division — usually because the module isn&apos;t licensed.
          {hiddenCount > 0 && ' A few entries were hidden entirely (path not available in your region).'}
        </div>
      )}

      <div className="space-y-5">
        {grouped.map(([category, items]) => {
          const pickableInGroup = items.filter(isPickable);
          return (
          <div key={category}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[11px] font-mono uppercase tracking-[0.12em] text-muted">
                {category}
              </h3>
              <button
                onClick={() => selectAllInGroup(items)}
                disabled={pickableInGroup.length === 0}
                className="text-[11px] text-muted hover:text-ocean disabled:opacity-40 disabled:hover:text-muted"
              >
                Select all
              </button>
            </div>
            <div className="space-y-1">
              {items.map((e) => {
                const state = e.state ?? 'available';
                const pickable = state === 'available';
                const checked = props.selected.has(e.name);
                return (
                <label
                  key={e.name}
                  className={cn(
                    'flex items-start gap-3 p-3 rounded-md border transition-colors',
                    pickable
                      ? cn(
                          'cursor-pointer',
                          checked
                            ? 'border-ocean bg-ocean-softer/40'
                            : 'border-line bg-raised hover:border-line-strong',
                        )
                      : 'cursor-not-allowed border-line bg-softer opacity-70',
                  )}
                  title={!pickable ? (e.reason ?? 'Not available') : undefined}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!pickable}
                    onChange={() => toggle(e.name)}
                    className="mt-0.5 accent-ocean disabled:cursor-not-allowed"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className={cn('text-[13px] font-medium', pickable ? 'text-ink' : 'text-muted-2 line-through decoration-muted-2/40')}>
                        {e.displayName ?? e.name}
                      </p>
                      {state === 'forbidden' && (
                        <span className="text-[10px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 rounded border border-line bg-bg text-muted">
                          Not licensed
                        </span>
                      )}
                      {state === 'error' && (
                        <span className="text-[10px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-800">
                          Couldn&apos;t verify
                        </span>
                      )}
                      {state === 'available' && e.rowCountSample === 0 && (
                        <span className="text-[10px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 rounded border border-line bg-bg text-muted">
                          No data yet
                        </span>
                      )}
                    </div>
                    {e.description && (
                      <p className="text-[11.5px] text-muted-2 mt-0.5">{e.description}</p>
                    )}
                    {!pickable && e.reason && (
                      <p className="text-[11.5px] text-muted-2 mt-0.5 italic">{e.reason}</p>
                    )}
                  </div>
                </label>
              );})}
            </div>
          </div>
        );})}
      </div>

      {props.saveError && (
        <div className="mt-4 px-3 py-2 rounded-md border border-rose-200 bg-rose-50 text-rose-900 text-[12.5px]">
          {props.saveError}
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        <button
          onClick={props.onBack}
          className="text-[13px] text-muted hover:text-ink flex items-center gap-1.5"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>
        <button
          onClick={props.onSave}
          disabled={props.selected.size === 0}
          className="px-4 py-2 bg-ocean text-white text-[13px] font-medium rounded-md hover:bg-ocean-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Save connection
        </button>
      </div>
    </div>
  );
}
