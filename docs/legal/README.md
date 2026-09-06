# Legal surface — status and how to take it live

**Everything in this area and under `frontend/lib/legal/` is a DRAFT prepared
by an AI assistant on 2026-09-01 (market-readiness P0-4). It is not legal
advice, it has not been reviewed by a lawyer, and it is deliberately NOT
presented to customers as a binding agreement.** The rendered pages carry a
visible "draft — not yet in force" banner, and registration does not yet ask
for acceptance, on purpose: presenting unreviewed AI text as the actual
contract is the one thing this work was instructed never to do.

## What exists

| Document | Canonical source | Rendered at |
|---|---|---|
| Terms of Service | `frontend/lib/legal/terms.ts` | `/legal/terms` |
| Privacy Policy | `frontend/lib/legal/privacy.ts` | `/legal/privacy` |
| Subprocessor list | `frontend/lib/legal/subprocessors.ts` | `/legal/subprocessors` |
| Data Processing Agreement (template) | `frontend/lib/legal/dpa.ts` | `/legal/dpa` |

One source each — the string module the page renders. There is no second copy
to drift (the contract-sync lesson).

## What the lawyer must settle (the placeholders)

- `[COMPANY LEGAL NAME]`, `[KBO/BCE NUMBER]`, `[REGISTERED ADDRESS]` — the
  actual legal entity. Search-and-replace across the four files.
- Governing law / venue (drafted as Belgian law, Dutch-speaking courts of
  Brussels — confirm).
- The Anthropic transfer mechanism (drafted as SCCs / EU-U.S. Data Privacy
  Framework — verify Anthropic's current certification status and DPA).
- Liability caps and warranty language in the ToS.
- Whether acceptance at registration should be a recorded checkbox with a
  stored `{terms_version, accepted_at}` (recommended) or the
  sentence-under-the-button form.

## Taking it live, in order

1. Lawyer reviews and edits the four string modules (they are plain text with
   markdown-style headings).
2. Flip the flag: set `LEGAL_IN_FORCE = true` and the real versions/dates in
   BOTH copies of the lint-locked pair, `backend/src/shared/legalVersions.ts`
   and `frontend/lib/legal/versions.ts` (CI refuses a build where they
   differ). That one edit removes the draft banner AND switches on the
   acceptance flow, which is already built (P0-7, 2026-09-06):
   - registration shows a required checkbox linking the three documents and
     the backend refuses a signup without it (`400 terms_required`);
   - every acceptance is a row in `legal_acceptances` (user, the three
     versions, source, ip, user agent, timestamp) — written in the same
     transaction as the user row at signup, and by `POST /api/legal/accept`
     from the in-app gate;
   - a signed-in user who has not accepted the CURRENT versions sees a
     blocking dialog on every screen until they do (`GET /api/legal/status`
     decides). Existing customers therefore accept on their next visit, and
     bumping any version re-asks everyone. No email step is needed.
3. Nothing to wire by hand. Bump a version in the pair whenever a document
   changes materially; the rows record which version each person accepted.

## Facts the drafts are grounded in (verified in code on 2026-09-01)

- Hosting entirely in Microsoft Azure, **West Europe**; Postgres Flexible
  Server (14-day point-in-time recovery), blob storage warehouse, Neo4j,
  Azure Communication Services for email.
- Questions, schema metadata, sampled field values and **query results** are
  sent to Anthropic's Claude API to generate answers — so customer content
  reaches Anthropic as a subprocessor and the drafts say so plainly.
- Security measures (DPA Annex II): TLS in transit, encryption at rest,
  AES-256-GCM for stored source credentials, Postgres row-level security +
  tenant-scoped semantic graph + per-tenant storage containers, RBAC, MFA
  (TOTP/WebAuthn/backup codes), email verification, audit log, deep health
  gating on deploys, metric + log alerting.
- Retention (`services/retention.ts`): notifications 90 days, AI usage log
  365 days, query history and conversations kept for the subscription term
  unless the operator configures a window.
- Erasure (`services/accountDeletion.ts`): user anonymisation and full tenant
  purge across database, warehouse files and semantic graph — irreversible.
- Export (`services/tenantExport.ts`, `GET /api/settings/export.zip`, the
  "Your data" tab on the team page): one ZIP with every tenant-scoped table
  as JSON, a manifest naming the withheld credential columns, and the
  warehouse file list (a 24 h read-only link in per-tenant container mode).
