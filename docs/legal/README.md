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
2. Remove the draft banner: set `LEGAL_IN_FORCE = true` in
   `frontend/app/legal/LegalPage.tsx` and set the real effective dates in the
   documents.
3. Wire acceptance into registration (the deliberately-missing piece): the
   register screen's agree-language plus, if the lawyer wants it recorded, an
   `accepted_terms_version` column on `users` stamped at signup.
4. Existing customers (if any by then) accept on next login or by email.

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
