'use client';

/**
 * OAuth popup landing page — same origin as the wizard so postMessage works.
 *
 * Backend's /api/source-types/:type/oauth-callback 303-redirects here with
 * the auth code + state in the URL fragment (#code=…&state=…). The
 * fragment is never sent to the server, so this page parses it client-side,
 * postMessages the result to the opener (`databridge:oauth` envelope), and
 * closes itself. The wizard's listener picks it up and continues the flow.
 *
 * Why bounce through frontend rather than postMessage from backend's domain
 * directly: cross-origin window.opener access is severed by COOP isolation
 * in modern browsers when the popup passes through a third-party login
 * page (e.g. ExactOnline's auth screen). Same-origin postMessage is reliable.
 */

import { useEffect } from 'react';

export default function OAuthReturnPage() {
  useEffect(() => {
    // Parse the fragment (#ok=1&code=…&state=…&type=… or #ok=0&error=…)
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);

    const okParam = params.get('ok');
    let msg: Record<string, unknown>;
    if (okParam === '1') {
      msg = {
        kind: 'databridge:oauth',
        ok: true,
        code: params.get('code'),
        state: params.get('state'),
        type: params.get('type'),
      };
    } else {
      msg = {
        kind: 'databridge:oauth',
        ok: false,
        error: params.get('error') ?? 'OAuth failed',
      };
    }

    // postMessage to opener. Same origin, so this is reliable.
    // We use targetOrigin === window.location.origin so we don't leak the
    // code to any window that happens to be in our browsing-context group.
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(msg, window.location.origin);
      } catch {
        // Swallow — the wizard's "popup closed" handler will surface this
        // as a clean error if postMessage somehow failed.
      }
    }

    // Brief delay so the message lands before close.
    const t = setTimeout(() => { window.close(); }, 200);
    return () => clearTimeout(t);
  }, []);

  return (
    <div style={{
      fontFamily: 'system-ui, sans-serif',
      padding: '2rem',
      color: '#0f172a',
      textAlign: 'center',
    }}>
      <p>Returning to DataBridge…</p>
    </div>
  );
}
