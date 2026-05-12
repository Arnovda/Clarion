/**
 * /security — public security posture page.
 *
 * Mirrors docs/SECURITY.md but reformatted for a prospect / their IT
 * director skimming the page to answer "is this product safe?" before
 * filling out a procurement questionnaire. Keep it honest — list the
 * gaps as well as the controls. Trust comes from accuracy, not from
 * polish.
 */

export const metadata = {
  title: 'Security · Clarion',
  description: 'How Clarion protects your data: tenant isolation, encryption, audit logging, and what we are still working on.',
};

export default function SecurityPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-16 text-ink">
      <header className="mb-12">
        <p className="text-[10px] font-mono tracking-[0.16em] uppercase text-muted mb-3">
          Security posture
        </p>
        <h1 className="font-display text-[44px] tracking-[-0.02em] leading-[1.1] mb-4">
          How Clarion protects your data
        </h1>
        <p className="text-[15px] text-ink-2 leading-relaxed max-w-2xl">
          We&rsquo;re an early-stage SaaS that holds business data customers
          care about. This page is the honest version of what we do, what
          we don&rsquo;t yet do, and where we&rsquo;re heading.
        </p>
        <p className="text-[12px] text-muted-2 mt-4 font-mono">
          Last updated: 2026-05-12
        </p>
      </header>

      <Section title="Hosting & architecture">
        <ul className="security-list">
          <li>Hosted on <Strong>Microsoft Azure (West Europe)</Strong> — EU data residency.</li>
          <li><Strong>Multi-tenant shared compute</Strong> with hard data isolation. One backend serves all tenants; each tenant&rsquo;s data is segregated at three layers (Postgres RLS, per-request transaction context, per-tenant storage paths).</li>
          <li>All traffic over <Strong>TLS 1.2+</Strong>. HTTPS-only on every public endpoint.</li>
          <li>Source code in a private GitHub repo; CI/CD via GitHub Actions to Azure Container Registry + Azure Container Apps.</li>
        </ul>
      </Section>

      <Section title="Tenant data isolation">
        <ul className="security-list">
          <li><Strong>Postgres Row-Level Security</Strong> enabled and FORCED on every tenant-scoped table. The database itself filters per-tenant — application bugs cannot override it.</li>
          <li><Strong>Per-request tenant transaction</Strong> — every authenticated request runs DB queries inside a <code>SET LOCAL</code>-scoped transaction so connection pool reuse cannot leak tenant context across requests.</li>
          <li><Strong>Per-tenant storage paths</Strong> — Delta/Parquet files in Azure Blob are namespaced <code>tenant_&lt;id&gt;/</code> so even path-level misconfiguration can&rsquo;t cross tenants.</li>
          <li>DuckDB query engine only receives URIs from the (tenant-RLS-filtered) catalog — it physically cannot scan a table outside the caller&rsquo;s tenant.</li>
        </ul>
      </Section>

      <Section title="Authentication">
        <ul className="security-list">
          <li>Passwords hashed with <Strong>bcrypt</Strong> (cost factor 12).</li>
          <li>Sessions use <Strong>JWT access tokens (15 min)</Strong> + <Strong>refresh tokens (30 days)</Strong>. Refresh tokens are server-side revocable — logout, password change, or admin action invalidates them immediately on every device.</li>
          <li>Three roles: <code>admin</code>, <code>analyst</code>, <code>viewer</code>. Role-based access enforced per endpoint.</li>
          <li>Production refuses to start with a weak JWT secret (rejects defaults, anything under 32 characters).</li>
          <li>Password reset tokens stored hashed (sha256) with 1-hour expiry.</li>
        </ul>
      </Section>

      <Section title="Secrets & encryption">
        <ul className="security-list">
          <li>Connection credentials encrypted at rest with <Strong>AES-256-GCM</Strong> (random IVs, authenticated). Backend refuses to start in production without an encryption key.</li>
          <li>Secrets stored in <Strong>Azure Key Vault</Strong>. Backend reads them via managed identity (no key-in-env in production).</li>
          <li>Backend reaches blob storage via managed identity. Worker jobs mint scoped user-delegation SAS tokens per execution.</li>
        </ul>
      </Section>

      <Section title="Audit trail">
        <ul className="security-list">
          <li>Every administrative action — user invites, role changes, connection edits, product deletions, password changes — is logged to an append-only <code>audit_events</code> table.</li>
          <li>Captured per event: actor (user + email + role at the time), action verb, target entity, JSONB context, source IP, user-agent.</li>
          <li>Visible to your admins at <code>/users → Audit log</code>. Tenant-scoped — only your organisation sees its own events.</li>
          <li>Every AI-generated SQL query logged separately with the question, the generated SQL, and a confidence score (<code>query_log</code>).</li>
        </ul>
      </Section>

      <Section title="Data durability">
        <ul className="security-list">
          <li><Strong>Postgres point-in-time recovery</Strong>, 14-day retention.</li>
          <li>Configurable geo-redundant backups (paired Azure region).</li>
          <li>Blob versioning + 30-day soft-delete on warehouse data.</li>
          <li>Key Vault 90-day soft-delete window for accidentally-revoked secrets.</li>
        </ul>
      </Section>

      <Section title="Supply chain & operations">
        <ul className="security-list">
          <li><Strong>Dependency vulnerability scan</Strong> (<code>npm audit</code>) runs on every PR. High-severity advisories fail the build.</li>
          <li><Strong>Strict TypeScript compile</Strong> gate prevents broken builds from reaching production.</li>
          <li>Vitest integration suite against a Postgres service container on every PR.</li>
          <li>Weekly Dependabot updates for backend, frontend, and GitHub Actions.</li>
        </ul>
      </Section>

      <Section title="What we&rsquo;re still working on">
        <p className="text-[13px] text-ink-2 leading-relaxed mb-4">
          The honest list. We&rsquo;d rather you know than discover it during an audit.
        </p>
        <ul className="security-list">
          <li><Strong>Penetration test</Strong> — budget allocated, vendor selection in progress.</li>
          <li><Strong>SOC 2 Type II</Strong> — we&rsquo;ll pursue this when a customer asks for it; the platform&rsquo;s controls are already aligned. ETA depends on demand; allow 12-18 months from kickoff.</li>
          <li><Strong>ISO 27001</Strong> — follows SOC 2.</li>
          <li><Strong>MFA</Strong> — planned. Implementation order tied to first enterprise request.</li>
          <li><Strong>Public Data Processing Agreement (DPA) template</Strong> — drafting with counsel.</li>
          <li><Strong>Sub-processor list</Strong> — to be published below when finalised.</li>
          <li><Strong>Incident response runbook</Strong> — internal process is in place; formal published version pending.</li>
        </ul>
      </Section>

      <Section title="Reporting a security issue">
        <p className="text-[13px] text-ink-2 leading-relaxed">
          Found something? Please reach us at{' '}
          <code className="font-mono text-ocean">security@clarion.io</code>.
          We commit to acknowledging within 48 hours and triaging within 5
          business days. Responsible disclosure protections apply: we
          won&rsquo;t pursue legal action against researchers acting in good
          faith.
        </p>
      </Section>

      <footer className="mt-16 pt-8 border-t border-line">
        <p className="text-[11px] text-muted-2">
          Questions? <code className="font-mono text-ocean">trust@clarion.io</code>.
          We&rsquo;ll provide our security questionnaire, current controls
          documentation, and DPA template on request.
        </p>
      </footer>

      <style>{`
        .security-list { list-style: disc; padding-left: 1.25rem; font-size: 13.5px; line-height: 1.65; color: var(--ink-2); }
        .security-list li { margin-bottom: 0.6rem; }
        .security-list code { font-size: 12px; padding: 1px 4px; background: var(--softer); border: 1px solid var(--line); border-radius: 3px; font-family: var(--font-mono); }
      `}</style>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="font-display text-[22px] tracking-[-0.01em] text-ink mb-4 border-b border-line pb-2">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Strong({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-ink">{children}</strong>;
}
