/**
 * Subprocessor list — DRAFT (P0-4).
 *
 * ⚠ AI-drafted 2026-09-01, NOT reviewed by a lawyer, NOT in force. See
 * docs/legal/README.md. This is the REAL list — every entry is a service the
 * platform demonstrably uses (verified in infra/ and the codebase); nothing
 * aspirational belongs here.
 */

export const SUBPROCESSORS_VERSION = '0.1-draft';
export const SUBPROCESSORS_UPDATED = '2026-09-01';

export const SUBPROCESSORS = `
# Subprocessors

*Version ${SUBPROCESSORS_VERSION}, last updated ${SUBPROCESSORS_UPDATED} — draft, not yet in force.*

We use the following subprocessors to provide Clarion. Each processes
customer data only on our documented instructions, under a data-processing
agreement with us.

## Microsoft Ireland Operations Ltd (Microsoft Azure)

- **What**: all hosting and storage — the application, the analytics
  database (Azure Database for PostgreSQL), the data-warehouse copies of your
  connected data (Azure Blob Storage), the semantic graph, background
  processing, monitoring and the sending of service email (Azure
  Communication Services).
- **Where**: West Europe region (Netherlands), European Union. Monitoring
  telemetry and email delivery metadata may involve other Microsoft EU
  facilities.

## Anthropic (Anthropic, PBC / Anthropic Ireland Ltd)

- **What**: the AI models that answer questions and generate dashboards and
  descriptions. Prompts can include questions, data-structure metadata,
  sampled field values and query results from your connected data. API inputs
  and outputs are not used to train Anthropic's models.
- **Where**: United States (and/or EU, depending on Anthropic's serving
  region). Transfer safeguarded by [EU-U.S. Data Privacy Framework and/or
  Standard Contractual Clauses — TO BE VERIFIED BY COUNSEL].

## Changes to this list

We give workspace admins at least 30 days' notice before adding or replacing
a subprocessor, with the right to object as set out in the Data Processing
Agreement. The version and date above identify the list in force.
`;
