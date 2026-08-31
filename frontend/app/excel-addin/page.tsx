'use client';

/**
 * The Excel add-in's task pane.
 *
 * Served by the Clarion frontend rather than hosted separately: an Office
 * add-in is a web page in a side panel, and giving it its own deployment
 * would mean a second thing to build, ship and keep in step with the API it
 * calls. `excel-addin/manifest.xml` points Excel at this route.
 *
 * Three things shape the design, and all three come from where it runs:
 *
 * **It is roughly 320 pixels wide.** So: one column, no chrome, no shell, and
 * short labels. The pane is a remote control, not a dashboard.
 *
 * **There is no Clarion session inside Excel.** So it authenticates with a
 * personal access token the user pastes once, kept in Office's roaming
 * settings so it follows them to their other machines. Never in the page's
 * own storage where another Clarion tab could read it.
 *
 * **Office.js may not be there.** The same URL opens in an ordinary browser
 * (which is how you check it renders), so every Excel call is guarded and the
 * pane degrades to a preview instead of a blank panel.
 */

import { useCallback, useEffect, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';
const TOKEN_SETTING = 'clarion.apiToken';

interface Question {
  id: number;
  question: string;
  verified: boolean;
}

interface RunResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

// Office.js is loaded from Microsoft's CDN by the script tag below; it is not
// an npm dependency. Only the handful of members this pane touches are typed.
interface OfficeGlobal {
  onReady: (cb: (info: { host?: unknown }) => void) => void;
  context: {
    document?: {
      settings: {
        get(name: string): unknown;
        set(name: string, value: unknown): void;
        saveAsync(cb: (r: { status: string }) => void): void;
      };
    };
  };
}
type ExcelRun = (batch: (ctx: ExcelContext) => Promise<void>) => Promise<void>;
interface ExcelContext {
  workbook: {
    worksheets: { getActiveWorksheet(): ExcelSheet };
  };
  sync(): Promise<void>;
}
interface ExcelSheet {
  getRange(address: string): ExcelRange;
  getUsedRange(): ExcelRange;
}
interface ExcelRange {
  values: unknown[][];
  format: { autofitColumns(): void };
  getResizedRange(rows: number, cols: number): ExcelRange;
}

declare global {
  interface Window {
    Office?: OfficeGlobal;
    Excel?: { run: ExcelRun };
  }
}

export default function ExcelAddinPane() {
  const [officeReady, setOfficeReady] = useState(false);
  const [inExcel, setInExcel] = useState(false);
  const [token, setToken] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [who, setWho] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);

  // ── Office bootstrap ────────────────────────────────────────────────────
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://appsforoffice.microsoft.com/lib/1/hosted/office.js';
    script.async = true;
    script.onload = () => {
      const office = window.Office;
      if (!office) { setOfficeReady(true); return; }
      office.onReady(() => {
        setOfficeReady(true);
        setInExcel(Boolean(window.Excel));
        const stored = office.context?.document?.settings?.get(TOKEN_SETTING);
        if (typeof stored === 'string' && stored) setToken(stored);
      });
    };
    // Opened outside Excel (a plain browser) — render the pane anyway so it
    // can be checked without sideloading.
    script.onerror = () => setOfficeReady(true);
    document.head.appendChild(script);
    return () => { script.remove(); };
  }, []);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 401) throw new Error('That token is not valid any more. Create a new one in Clarion.');
    if (!res.ok) throw new Error('Clarion could not answer that request.');
    return (await res.json()).data;
  }, [token]);

  // ── Load once a token is present ────────────────────────────────────────
  useEffect(() => {
    if (!token) { setWho(null); setQuestions([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const me = await call('/addin/me');
        if (cancelled) return;
        setWho(me.displayName || me.email);
        const list = await call('/addin/questions');
        if (!cancelled) setQuestions(list ?? []);
        setStatus('');
      } catch (e) {
        if (!cancelled) {
          setWho(null);
          setStatus(e instanceof Error ? e.message : 'Could not reach Clarion.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [token, call]);

  function saveToken() {
    const value = tokenInput.trim();
    if (!value) return;
    setToken(value);
    setTokenInput('');
    const settings = window.Office?.context?.document?.settings;
    if (settings) {
      settings.set(TOKEN_SETTING, value);
      settings.saveAsync(() => undefined);
    }
  }

  function forgetToken() {
    setToken('');
    setWho(null);
    setQuestions([]);
    const settings = window.Office?.context?.document?.settings;
    if (settings) {
      settings.set(TOKEN_SETTING, '');
      settings.saveAsync(() => undefined);
    }
  }

  async function insert(q: Question) {
    setBusy(true);
    setStatus(`Running "${q.question}"…`);
    try {
      const result: RunResult = await call(`/addin/questions/${q.id}/run`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (result.rows.length === 0) {
        setStatus('That question returned no rows.');
        return;
      }
      if (!window.Excel) {
        setStatus(`${result.rows.length} rows ready. Open this pane inside Excel to insert them.`);
        return;
      }
      await writeToSheet(result);
      setStatus(
        result.truncated
          ? `Inserted the first ${result.rows.length} rows — there were more.`
          : `Inserted ${result.rows.length} rows.`,
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────
  if (!officeReady) {
    return <Pane><p style={S.muted}>Starting…</p></Pane>;
  }

  if (!token || !who) {
    return (
      <Pane>
        <h1 style={S.h1}>Connect to Clarion</h1>
        <p style={S.muted}>
          In Clarion, open your profile and create an access token under
          &ldquo;Access tokens&rdquo;. Paste it here once.
        </p>
        <input
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="clr_…"
          style={S.input}
          spellCheck={false}
          autoComplete="off"
        />
        <button onClick={saveToken} disabled={!tokenInput.trim()} style={S.primary}>
          Connect
        </button>
        {status && <p style={S.error}>{status}</p>}
      </Pane>
    );
  }

  return (
    <Pane>
      <div style={S.headerRow}>
        <span style={S.who}>{who}</span>
        <button onClick={forgetToken} style={S.link}>Sign out</button>
      </div>
      {!inExcel && (
        <p style={S.note}>
          Not running inside Excel — you can browse your questions, but nothing can be inserted.
        </p>
      )}
      <h1 style={S.h1}>Your saved questions</h1>
      {questions.length === 0 ? (
        <p style={S.muted}>
          No saved questions yet. Ask something in Clarion and save the answer, then it appears here.
        </p>
      ) : (
        <ul style={S.list}>
          {questions.map((q) => (
            <li key={q.id} style={S.item}>
              <div style={S.qText}>
                {q.verified && <span style={S.badge}>Verified</span>}
                {q.question}
              </div>
              <button onClick={() => void insert(q)} disabled={busy} style={S.secondary}>
                Insert
              </button>
            </li>
          ))}
        </ul>
      )}
      {status && <p style={S.status}>{status}</p>}
    </Pane>
  );
}

/**
 * Write the result into the active worksheet.
 *
 * Anchored at A1 and sized to the data. Cells Excel cannot hold natively —
 * objects, arrays — are stringified rather than dropped, because a blank cell
 * where a value existed is the kind of silent loss that makes a number wrong
 * without looking wrong.
 */
async function writeToSheet(result: RunResult): Promise<void> {
  const excel = window.Excel;
  if (!excel) return;
  const header = result.columns;
  const body = result.rows.map((r) => header.map((c) => toCell(r[c])));
  const grid = [header, ...body];

  await excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getActiveWorksheet();
    // Clear first so a smaller result cannot leave a previous, larger one's
    // rows below it — which would read as part of the new answer.
    sheet.getUsedRange().values = [[]];
    await ctx.sync();

    const range = sheet.getRange('A1').getResizedRange(grid.length - 1, header.length - 1);
    range.values = grid;
    range.format.autofitColumns();
    await ctx.sync();
  });
}

function toCell(v: unknown): string | number | boolean {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  return JSON.stringify(v);
}

function Pane({ children }: { children: React.ReactNode }) {
  return <div style={S.pane}>{children}</div>;
}

/**
 * Inline styles rather than the app's Tailwind classes: the pane is rendered
 * by Excel's embedded browser at a fixed narrow width and must not inherit
 * the shell's layout assumptions. Kept small and literal on purpose.
 */
const S: Record<string, React.CSSProperties> = {
  pane: { padding: '14px 14px 24px', fontFamily: 'system-ui, "Segoe UI", sans-serif', fontSize: 13, color: '#16202A', maxWidth: 420 },
  h1: { fontSize: 15, fontWeight: 600, margin: '10px 0 6px' },
  muted: { fontSize: 12, color: '#5C6B78', lineHeight: 1.5, margin: '0 0 10px' },
  note: { fontSize: 11.5, color: '#8A5B24', background: '#F3EADC', padding: '6px 8px', borderRadius: 4, margin: '0 0 10px', lineHeight: 1.45 },
  input: { width: '100%', padding: '7px 9px', fontSize: 12, fontFamily: 'ui-monospace, monospace', border: '1px solid #D6DDE1', borderRadius: 4, marginBottom: 8, boxSizing: 'border-box' },
  primary: { width: '100%', padding: '8px 10px', fontSize: 13, fontWeight: 500, color: '#fff', background: '#14596B', border: 0, borderRadius: 4, cursor: 'pointer' },
  secondary: { padding: '4px 10px', fontSize: 12, color: '#14596B', background: '#fff', border: '1px solid #14596B', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap' },
  link: { fontSize: 11, color: '#5C6B78', background: 'none', border: 0, cursor: 'pointer', padding: 0 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingBottom: 8, borderBottom: '1px solid #E4EAED' },
  who: { fontSize: 12, color: '#3A4A57', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  item: { display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid #E4EAED' },
  qText: { fontSize: 12.5, lineHeight: 1.4, minWidth: 0 },
  badge: { display: 'inline-block', fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#14596B', background: '#E2EEF1', padding: '1px 5px', borderRadius: 3, marginRight: 6, verticalAlign: 1 },
  status: { fontSize: 11.5, color: '#3A4A57', marginTop: 10, lineHeight: 1.45 },
  error: { fontSize: 11.5, color: '#8A2E2B', marginTop: 8, lineHeight: 1.45 },
};
