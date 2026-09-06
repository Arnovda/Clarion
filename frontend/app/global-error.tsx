'use client';

/**
 * Root error boundary (assessment 9-1): catches a throw in the ROOT layout
 * itself, where app/error.tsx cannot help. It replaces <html> and <body>,
 * so globals.css is not guaranteed — the styling is inline and the copy
 * is the same as app/error.tsx.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#f6f5f2', color: '#1a1f24', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ width: '100%', maxWidth: 480, background: '#fff', border: '1px solid #e2e4e8', borderRadius: 8, padding: '40px 32px' }}>
            <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#6b7680', margin: '0 0 12px' }}>Something went wrong</p>
            <h1 style={{ fontFamily: 'Georgia, serif', fontWeight: 500, fontSize: 30, lineHeight: 1.15, margin: '0 0 12px' }}>Clarion could not start this page.</h1>
            <p style={{ fontSize: 14, color: '#6b7680', lineHeight: 1.6, margin: '0 0 32px' }}>
              Trying again usually works; if it keeps happening, tell us and quote the reference below.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
              <button type="button" onClick={() => reset()} style={{ padding: '8px 16px', borderRadius: 6, background: '#164e63', color: '#fff', border: 0, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Try again</button>
              <a href="/home" style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #e2e4e8', color: '#1a1f24', fontSize: 13, fontWeight: 500, textDecoration: 'none' }}>Go to home</a>
            </div>
            {error.digest && <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10.5, color: '#9aa3ad', margin: 0 }}>reference {error.digest}</p>}
          </div>
        </main>
      </body>
    </html>
  );
}
