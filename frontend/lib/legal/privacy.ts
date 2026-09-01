/**
 * Privacy Policy — DRAFT (P0-4).
 *
 * ⚠ AI-drafted 2026-09-01, NOT reviewed by a lawyer, NOT in force. See
 * docs/legal/README.md. Grounded in the platform's verified behaviour —
 * notably that questions, schema metadata, sampled values and query results
 * reach Anthropic's API, and the real retention/erasure mechanics.
 */

export const PRIVACY_VERSION = '0.1-draft';
export const PRIVACY_UPDATED = '2026-09-01';

export const PRIVACY = `
# Privacy Policy

*Version ${PRIVACY_VERSION}, last updated ${PRIVACY_UPDATED} — draft, not yet in force.*

## 1. Two roles, two situations

**For your workspace's connected data** (the business records Clarion copies
from your systems — invoices, customers, suppliers, ledger entries and so on,
which can contain personal data about your customers, suppliers and staff),
**you are the controller and we are your processor**. That processing is
governed by the Data Processing Agreement, not by this policy. This policy
covers what **we** decide about, as controller:

**Account data** — the details of the people who use Clarion itself.

## 2. What we collect about platform users, and why

- **Account details**: name, work email, hashed password (or passkey),
  workspace, role. To provide the service, secure sign-in and email
  verification. Legal basis: performance of a contract.
- **Security records**: sign-in events, multi-factor settings, audit trail of
  administrative actions, API tokens you create. To keep the workspace
  secure and to demonstrate who did what. Legal basis: legitimate interest
  in security; legal obligations where applicable.
- **Usage and diagnostics**: request logs, error telemetry, AI usage
  accounting per workspace. To operate, debug and bill the service. Legal
  basis: legitimate interest in running the service; contract for billing.
- **Emails we send**: verification links, password resets, notifications and
  scheduled reports you configure, via Azure Communication Services.

We do not sell personal data and we do not use your data to advertise to you.

## 3. Where data lives

The service runs entirely on Microsoft Azure in the **West Europe** region
(Netherlands). Your connected data, the warehouse copies, the analytics
database and backups stay in the EU.

## 4. The one transfer to know about: AI processing

To answer questions and generate dashboards, the service sends prompts to
**Anthropic's Claude API**. Those prompts can include your questions, the
structure of your data, sampled field values, and the results of queries over
your connected data — which may include personal data contained in it.
Under our agreement with Anthropic, API inputs and outputs are not used to
train their models. Anthropic may process data in the United States; the
transfer is safeguarded by [EU-U.S. Data Privacy Framework certification
and/or Standard Contractual Clauses — TO BE VERIFIED BY COUNSEL AGAINST
ANTHROPIC'S CURRENT TERMS]. The full subprocessor list is published at
/legal/subprocessors.

## 5. How long we keep things

- Account data: for the life of the account, then erased or anonymised.
- Notifications: 90 days.
- AI usage accounting: 12 months.
- Question history and conversations: for the subscription term (your
  workspace admin can ask us to configure a shorter window).
- Connected-data copies: until you disconnect the source or the workspace is
  deleted.
- On workspace deletion, everything above is purged — database records,
  warehouse files and the semantic layer — irreversibly, within 30 days.

## 6. Your rights

You can access, correct, export or erase your account data, object to or
restrict processing, and complain to a supervisory authority (in Belgium: the
Gegevensbeschermingsautoriteit / Autorité de protection des données,
www.dataprotectionauthority.be). Erasure of a user account anonymises the
personal details and removes the credentials while keeping the workspace's
records intact. Write to [PRIVACY CONTACT EMAIL] for any request.

If your personal data appears in a **customer's connected data**, that
customer is the controller — we will refer your request to them and assist
them as their processor.

## 7. Cookies and local storage

The web application uses functional storage only: your sign-in token and
interface preferences (such as a collapsed sidebar). No advertising or
cross-site tracking cookies.

## 8. Security

In short: encryption in transit and at rest, encrypted storage of source
credentials, strict workspace isolation enforced in the database layer,
role-based access, optional multi-factor authentication, audit logging, and
monitored, health-gated deployments. Annex II of the Data Processing
Agreement describes the measures in full.

## 9. Changes and contact

Material changes are announced to workspace admins in advance. Controller:
[COMPANY LEGAL NAME], [REGISTERED ADDRESS], [KBO/BCE NUMBER] —
[PRIVACY CONTACT EMAIL].
`;
