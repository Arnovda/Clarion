/**
 * Data Processing Agreement (template) — DRAFT (P0-4).
 *
 * ⚠ AI-drafted 2026-09-01, NOT reviewed by a lawyer, NOT in force. See
 * docs/legal/README.md. GDPR Art. 28 requires this contract to exist BEFORE
 * processing begins — which is why it is drafted for incorporation into the
 * Terms of Service (self-serve acceptance at signup) rather than as a
 * separately signed document. Annex II states only measures the platform
 * demonstrably implements.
 */

export const DPA_VERSION = '0.1-draft';
export const DPA_UPDATED = '2026-09-01';

export const DPA = `
# Data Processing Agreement

*Version ${DPA_VERSION}, last updated ${DPA_UPDATED} — draft, not yet in force.
Forms part of the Terms of Service.*

## 1. Parties and scope

This agreement governs the personal data that [COMPANY LEGAL NAME]
("processor") processes on behalf of the customer ("controller") in providing
Clarion, per Article 28 GDPR. It applies to the customer's connected data;
account data of the customer's own platform users is covered by the Privacy
Policy, where the processor acts as controller.

## 2. Subject matter, duration, nature and purpose

Processing consists of copying the customer's connected business systems into
a hosted data warehouse, transforming that data into analytical models, and
serving analytics — dashboards, reports and AI-assisted answers — to the
customer's users. It lasts for the term of the service agreement.

## 3. Categories of data and data subjects (Annex I)

- **Data subjects**: the customer's own customers, suppliers, contacts and —
  depending on the systems connected — employees; the customer's platform
  users.
- **Data categories**: business and accounting records as present in the
  connected systems: names, contact and address details, VAT/enterprise
  numbers, bank account numbers, invoice and payment details, ledger entries,
  product and order data; and any other personal data the customer chooses to
  connect. The customer must not connect special categories of data (Art. 9)
  without prior written agreement.

## 4. Processor obligations

The processor shall:

- process personal data only on the controller's documented instructions —
  in practice: the configuration the controller makes in the service (which
  systems to connect, which entities to sync, which users to invite) —
  including as regards international transfers, unless required by EU or
  member-state law, in which case the processor informs the controller before
  processing unless that law forbids it;
- ensure persons authorised to process the data are bound by confidentiality;
- implement the technical and organisational measures of Annex II;
- respect the subprocessor conditions of section 5;
- taking into account the nature of the processing, assist the controller
  with data-subject requests (the service provides in-product user erasure,
  data export and full workspace deletion) and with Articles 32–36;
- at the controller's choice, delete or return all personal data at the end
  of the service: workspace deletion purges the database records, the
  warehouse copies and the semantic layer irreversibly within 30 days, except
  where EU or member-state law requires storage;
- make available the information necessary to demonstrate compliance and
  allow for and contribute to audits, at the controller's expense, at most
  once per year on 30 days' notice, without access to other customers' data.

## 5. Subprocessors

The controller gives general authorisation for the subprocessors listed at
/legal/subprocessors. The processor imposes data-protection obligations on
each subprocessor equivalent to this agreement and remains fully liable for
their performance. New or replacement subprocessors are announced to
workspace admins at least 30 days in advance; the controller may object on
reasonable data-protection grounds, and if no solution is found may terminate
the affected service.

## 6. International transfers

Processing and storage occur in the European Union (Microsoft Azure, West
Europe). The one exception is AI processing by Anthropic, which may occur in
the United States, safeguarded by [EU-U.S. Data Privacy Framework
certification and/or the European Commission's Standard Contractual Clauses —
TO BE VERIFIED BY COUNSEL].

## 7. Personal-data breaches

The processor notifies the controller without undue delay after becoming
aware of a personal-data breach affecting the controller's data, with the
information reasonably needed for the controller's own Art. 33/34
obligations, and documents breaches and remediation.

## 8. Annex II — technical and organisational measures

- **Encryption**: TLS for all data in transit; encryption at rest across the
  database, warehouse storage and backups; source-system credentials
  additionally encrypted with AES-256-GCM before storage.
- **Tenant isolation**: enforced in the database layer (PostgreSQL row-level
  security, running as a role that cannot bypass it), in the semantic graph
  (every query carries the workspace's identity, held in place by automated
  merge gates), and in storage (per-workspace containers).
- **Access control**: role-based access (admin/analyst/viewer); short-lived
  signed tokens; optional multi-factor authentication (authenticator app,
  passkeys, backup codes); email verification at registration; machine
  tokens scoped to read-only endpoints, revocable, resolving their owner's
  live permissions.
- **Auditability**: an audit trail of administrative and data-affecting
  actions; structured request logging; AI usage accounting per workspace.
- **Operations**: deployments gated on automated tests and on a deep health
  check of every dependency before customer traffic is shifted; metric and
  log alerts routed to on-call staff; point-in-time recovery (14 days) on
  the primary database.
- **Data minimisation towards the AI subprocessor**: prompts carry the data
  needed for the answer (question, structure, sampled values, query
  results); API data is not used for model training.
- **Personnel**: access to production restricted to authorised operators;
  secrets held in the platform's secret store, never in code.

## 9. Liability and precedence

Liability follows the Terms of Service. If this agreement conflicts with the
Terms, this agreement prevails for personal-data processing.
`;
