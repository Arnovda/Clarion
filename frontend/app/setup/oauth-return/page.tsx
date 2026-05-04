'use client';

/**
 * OAuth popup landing page — same origin as the wizard so postMessage works.
 *
 * Backend's /api/source-types/:type/oauth-callback 303-redirects here with
 * the auth code + state in the URL fragment (#code=…&state=…). The
 * fragment is never sent to the server, so this page parses it client-side,
 * postMessages the result to the opener (`clarion:oauth` envelope), and
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
        kind: 'clarion:oauth',
        ok: true,
        code: params.get('code'),
        state: params.get('state'),
        type: params.get('type'),
      };
    } else {
      msg = {
        kind: 'clarion:oauth',
        ok: false,
        error: params.get('error') ?? 'OAuth failed',
      };
    }

    // Send via BroadcastChannel — same-origin reliable channel that does
    // NOT depend on window.opener. The opener link is severed when the
    // popup passes through a third-party auth screen with strict COOP
    // (e.g. ExactOnline's), so window.opener can be null here even though
    // we're on the same origin as the wizard.
    //
    // BroadcastChannel works as long as both sides are on the same origin
    // (which they are — both on the frontend domain).
    try {
      const channel = new BroadcastChannel('clarion-oauth');
      channel.postMessage(msg);
      channel.close();
    } catch {
      // Browser doesn't support BroadcastChannel? Fall back to opener.
      if (window.opener && !window.opener.closed) {
        try { window.opener.postMessage(msg, window.location.origin); } catch { /* swallowed */ }
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
      <p>Returning to Clarion…</p>
    </div>
  );
}
