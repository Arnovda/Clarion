'use client';

import { useRef, useState, useCallback } from 'react';
import api from '@/lib/api';

interface PyodideInstance {
  runPythonAsync: (code: string) => Promise<unknown>;
  loadPackagesFromImports: (code: string) => Promise<void>;
  globals: { set: (key: string, value: unknown) => void; get: (key: string) => unknown };
  FS: { writeFile: (path: string, data: string) => void };
  runPython: (code: string) => unknown;
  registerJsModule: (name: string, module: Record<string, unknown>) => void;
}

interface PythonResult {
  stdout: string;
  stderr: string;
  result: unknown;
  /** Base64 PNG images from matplotlib */
  images: string[];
  error: string | null;
}

/**
 * Where the Python runtime is served from (assessment 4-2). Production serves
 * it from THIS origin — `scripts/vendor-pyodide.mjs` puts the core and the
 * numpy/pandas/matplotlib wheels under public/pyodide/ at build time — so a
 * notebook never makes the browser contact a CDN. The CDN fallback exists
 * for local development only (a checkout built with PYODIDE_VENDOR=skip);
 * a production build without the vendored files fails loudly here instead
 * of quietly reaching out to a host that is in no subprocessor list.
 */
const PYODIDE_VERSION = '0.26.4';
const SELF_HOSTED_BASE = '/pyodide/';
const CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

async function resolvePyodideBase(): Promise<string> {
  try {
    const probe = await fetch(`${SELF_HOSTED_BASE}pyodide-lock.json`, { method: 'HEAD' });
    if (probe.ok) return SELF_HOSTED_BASE;
  } catch { /* fall through */ }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The Python runtime is not installed on this deployment (public/pyodide is missing — the build did not vendor it).');
  }
  console.warn('[notebooks] public/pyodide is missing — development fallback to the Pyodide CDN. Run `node scripts/vendor-pyodide.mjs` to self-host.');
  return CDN_BASE;
}

/**
 * Hook to lazily load Pyodide and run Python code in the browser.
 * Provides a Databricks-like `sql()` function in Python that queries
 * DuckDB on the server and returns a pandas DataFrame.
 */
export function usePyodide() {
  const pyodideRef = useRef<PyodideInstance | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const connectionIdRef = useRef<number | null>(null);

  /** Set the connection ID used by Python's sql() function */
  const setConnectionId = useCallback((id: number | null) => {
    connectionIdRef.current = id;
  }, []);

  const loadPyodide = useCallback(async (): Promise<PyodideInstance> => {
    if (pyodideRef.current) return pyodideRef.current;

    setLoading(true);
    try {
      const base = await resolvePyodideBase();
      // Dynamic import — resolved at runtime, not by TS/bundler.
      const { loadPyodide: loader } = await import(
        /* webpackIgnore: true */
        `${base}pyodide.mjs`
      );
      const pyodide = await loader({ indexURL: base }) as PyodideInstance;

      // Pre-load common packages
      await pyodide.loadPackagesFromImports('import pandas, numpy, json');

      // Register JS module so Python can call back to execute SQL
      pyodide.registerJsModule('_notebook_bridge', {
        execute_sql: async (query: string): Promise<string> => {
          const connId = connectionIdRef.current;
          if (!connId) return JSON.stringify({ error: 'No connection selected' });
          try {
            const res = await api.post('/notebooks/query', { connectionId: connId, sql: query });
            if (res.data.ok) {
              return JSON.stringify(res.data.data);
            }
            return JSON.stringify({ error: res.data.error || 'Query failed' });
          } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : 'Query failed' });
          }
        },
      });

      // Set up Python helpers: sql(), get_df(), stdout/image capture
      pyodide.runPython(`
import sys, io, json, pandas as pd
from _notebook_bridge import execute_sql
from pyodide.ffi import run_sync

class _CapturedOutput:
    def __init__(self):
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()
        self.images = []
    def reset(self):
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()
        self.images = []

_capture = _CapturedOutput()

# SQL results cache for get_df()
_sql_results = {}

def get_df(cell_id):
    """Get a previously-executed SQL cell result as a pandas DataFrame."""
    data = _sql_results.get(str(cell_id), [])
    return pd.DataFrame(data)

def df(cell_id):
    """Alias for get_df."""
    return get_df(cell_id)

def sql(query):
    """Run a SQL query against DuckDB and return a pandas DataFrame.

    Uses 2-level namespaces: source_name.table_name or product_name.table_name

    Examples:
        df = sql("SELECT * FROM wholesale_erp.artikelgroepen")
        df = sql("SELECT * FROM catalogue.dim_article LIMIT 10")
    """
    result_json = run_sync(execute_sql(query))
    result = json.loads(result_json)
    if 'error' in result:
        raise Exception(result['error'])
    return pd.DataFrame(result.get('rows', []))

def display(df, max_rows=20):
    """Pretty-print a DataFrame."""
    if hasattr(df, 'to_string'):
        print(df.head(max_rows).to_string())
    else:
        print(df)
`);

      pyodideRef.current = pyodide;
      setReady(true);
      return pyodide;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Register SQL cell results so Python cells can access them via get_df(cellId).
   */
  const setSqlResult = useCallback((cellId: string, rows: unknown[]) => {
    const pyodide = pyodideRef.current;
    if (pyodide) {
      try {
        const json = JSON.stringify(rows);
        pyodide.runPython(`_sql_results["${cellId}"] = json.loads('''${json.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}''')`);
      } catch {
        // non-fatal
      }
    }
  }, []);

  /**
   * Execute Python code and return captured output.
   */
  const runPython = useCallback(async (code: string): Promise<PythonResult> => {
    const pyodide = await loadPyodide();

    // Reset capture
    pyodide.runPython('_capture.reset()');

    // Try to load any additional imports
    try {
      await pyodide.loadPackagesFromImports(code);
    } catch {
      // Some imports may not be available
    }

    // Wrap code to capture output + matplotlib
    const wrappedCode = `
import sys
sys.stdout = _capture.stdout
sys.stderr = _capture.stderr
_capture.images = []

# Check if matplotlib is used and configure it
_has_matplotlib = False
try:
    if 'matplotlib' in '''${code.replace(/'/g, "\\'")}''' or 'plt' in '''${code.replace(/'/g, "\\'")}''':
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        _has_matplotlib = True
except:
    pass

# Execute user code
_result = None
try:
    exec('''${code.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}''')
except Exception as _e:
    print(str(_e), file=sys.stderr)

# Capture matplotlib figures
if _has_matplotlib:
    import base64
    for _fig_num in plt.get_fignums():
        _fig = plt.figure(_fig_num)
        _buf = io.BytesIO()
        _fig.savefig(_buf, format='png', dpi=100, bbox_inches='tight', facecolor='white')
        _buf.seek(0)
        _capture.images.append(base64.b64encode(_buf.read()).decode())
        _buf.close()
    plt.close('all')

sys.stdout = sys.__stdout__
sys.stderr = sys.__stderr__
`;

    try {
      await pyodide.runPythonAsync(wrappedCode);

      const stdout = pyodide.runPython('_capture.stdout.getvalue()') as string;
      const stderr = pyodide.runPython('_capture.stderr.getvalue()') as string;
      const imagesJson = pyodide.runPython('json.dumps(_capture.images)') as string;
      const images = JSON.parse(imagesJson) as string[];

      return {
        stdout: stdout || '',
        stderr: stderr || '',
        result: null,
        images,
        error: stderr && !stdout ? stderr : null,
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: '',
        result: null,
        images: [],
        error: err instanceof Error ? err.message : 'Python execution failed',
      };
    }
  }, [loadPyodide]);

  return { loading, ready, runPython, setSqlResult, setConnectionId };
}
