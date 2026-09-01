/**
 * Terms of Service — DRAFT (P0-4).
 *
 * ⚠ AI-drafted 2026-09-01, NOT reviewed by a lawyer, NOT in force. See
 * docs/legal/README.md for the review checklist and the go-live steps.
 * Plain text with markdown-style headings; rendered by app/legal/LegalPage.
 */

export const TERMS_VERSION = '0.1-draft';
export const TERMS_UPDATED = '2026-09-01';

export const TERMS = `
# Terms of Service

*Version ${TERMS_VERSION}, last updated ${TERMS_UPDATED} — draft, not yet in force.*

## 1. Who we are

Clarion is operated by [COMPANY LEGAL NAME], registered in Belgium under
enterprise number [KBO/BCE NUMBER], with registered office at
[REGISTERED ADDRESS] ("we", "us", "Clarion").

## 2. What the service is

Clarion is a business-analytics platform. You connect your business systems
(such as your accounting package or a database), Clarion keeps a copy of the
connected data in a data warehouse hosted in the European Union, and you and
your team explore that data through dashboards, reports and questions asked in
plain language, answered with the help of artificial-intelligence models.

Clarion is offered to businesses, not to consumers. By creating a workspace
you confirm you are acting for a business and are authorised to bind it.

## 3. Your account and your team

You are responsible for the accuracy of your registration details, for keeping
credentials confidential, and for everything done under your workspace's
accounts. Roles (admin, analyst, viewer) control what each team member can do;
assigning them is your responsibility. Multi-factor authentication is
available and we recommend enabling it.

## 4. Your data

Between you and us, you own the data you connect and everything derived from
it inside your workspace. You grant us the right to host, copy, transform and
process that data only as needed to provide the service, as described in the
Privacy Policy and the Data Processing Agreement (which forms part of these
terms for personal data we process on your behalf).

You are responsible for having the right to connect the data you connect —
including, where it contains personal data, a lawful basis under the GDPR.

## 5. Artificial intelligence

Parts of the service generate content (answers, SQL queries, dashboards,
descriptions) using AI models provided by our subprocessor Anthropic. To do
this, questions, data-structure metadata, sampled values and query results
from your connected data are sent to the model. AI-generated output can be
wrong; the service shows its working (sources, checks, confidence signals) and
you remain responsible for decisions taken on the basis of the output.

## 6. Acceptable use

You must not: use the service to break the law; attempt to access another
customer's workspace or probe the service's security; resell the service
without our written agreement; introduce malicious code; or use the output to
build a competing dataset of another party's confidential data you have no
right to.

We may suspend a workspace that endangers the service or other customers,
narrowly and for no longer than needed.

## 7. Fees

Fees, plans and any usage-based components (such as AI usage allowances) are
as stated at ordering. [PRICING TERMS TO BE COMPLETED WHEN THE COMMERCIAL
LAYER (P0-3) EXISTS.] VAT is added where applicable.

## 8. Availability and support

We operate the service with commercially reasonable care, with automated
health checks gating deployments and monitoring that alerts us to failures.
The service is provided without a guaranteed uptime level unless a separate
service-level agreement says otherwise. Planned maintenance is announced when
it is expected to be disruptive.

## 9. Termination and what happens to data

Either party may end the agreement as set out in the order or, if none, with
one month's notice. On termination we delete your workspace's data — the
database records, the warehouse copies of your connected data, and the
semantic layer — within 30 days, except where law requires longer retention.
Deletion is irreversible; export what you need before the end.

## 10. Liability

Nothing in these terms excludes liability that cannot be excluded by law.
Otherwise, our total liability under these terms is limited to the fees you
paid in the 12 months before the event giving rise to the claim, and neither
party is liable for indirect or consequential damages, including lost profits
or lost data to the extent it could have been prevented by the other party's
reasonable backups or exports. [LIABILITY POSITION TO BE CONFIRMED BY
COUNSEL.]

## 11. Changes

We may update these terms; material changes are announced at least 30 days in
advance to workspace admins. Continued use after the effective date is
acceptance. The version and date at the top identify the text in force.

## 12. Law and venue

Belgian law applies. Disputes go to the Dutch-speaking courts of Brussels,
without prejudice to mandatory venue rules. [CONFIRM.]
`;
