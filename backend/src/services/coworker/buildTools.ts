/**
 * Proposals that BUILD: one subject table from its saved SQL, and a source's
 * first set of subjects ("Create my topics").
 *
 * A saved SQL change keeps the table serving its previous result until it is
 * rebuilt — so a coworker that can change SQL but not offer the rebuild leaves
 * the person believing a change is live that is not. A rebuild is still a
 * person's click: these only propose it.
 *
 * NOT here, on purpose: rebuilding a whole subject (the subject's own Rebuild
 * button — it re-runs every table and is admin-only).
 */
import { randomUUID } from 'crypto';
import type { CoworkerProposal } from '../../shared/contract';
import {
  type CoworkerTool, ToolError, clip, posInt, text, get, optPosInt, subjectTableIdByName,
} from './toolKit';

const proposeRebuildTable: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_rebuild_table',
    description: 'Propose building ONE subject table now from its saved SQL, so its data (and Ask AI\'s answers) show the change. Use it after a SQL change was kept, or when open_table says changed_since_last_build. Not for a whole subject.',
    input_schema: {
      type: 'object',
      properties: {
        table_id: { type: 'integer' },
        table_name: { type: 'string', description: 'When you have no id.' },
        why: { type: 'string', description: 'One sentence the person reads: what the rebuild brings in.' },
      },
      required: ['why'],
      additionalProperties: false,
    },
  },
  label: () => 'Preparing a rebuild of the table',
  async run(ctx, input) {
    const byId = optPosInt(input, 'table_id');
    const name = text(input, 'table_name', 128, false);
    if (!byId && !name) throw new ToolError('Give table_id or table_name.');
    const tableId = byId ?? await subjectTableIdByName(ctx, name, null);
    const d = await get(ctx, `/products/tables/${tableId}/declaration`);
    if (d?.is_copy) throw new ToolError('This table is a copy of a shared table — rebuild the original instead.');
    if (!String(d?.transformation_sql ?? '').trim()) throw new ToolError('This table has no SQL yet — propose its SQL first.');
    const proposal: CoworkerProposal = {
      id: randomUUID(), kind: 'rebuild', tableId,
      tableName: String(d?.table_name ?? ''), label: String(d?.display_name || d?.table_name || `table ${tableId}`),
      why: text(input, 'why', 400),
    };
    return {
      proposal,
      focus: { kind: 'table', tableId, tab: 'sql' },
      detail: d?.pending_rebuild ? 'has saved changes to build' : 'already built — would refresh it',
      result: { proposed: true, had_unbuilt_changes: !!d?.pending_rebuild },
    };
  },
};

const proposeFirstBuild: CoworkerTool = {
  kind: 'propose',
  definition: {
    name: 'propose_first_build',
    description: 'Propose "Create the subjects" for a synced source that has NO subjects yet: Clarion designs and builds its subjects and shared lookups. For a source that already has subjects, use propose_new_subject instead.',
    input_schema: {
      type: 'object',
      properties: { connection_id: { type: 'integer' } },
      required: ['connection_id'],
      additionalProperties: false,
    },
  },
  label: () => 'Preparing the first build of the source',
  async run(ctx, input) {
    const connectionId = posInt(input, 'connection_id');
    const overview = await get(ctx, '/products/build-overview');
    const src = ((overview?.sources ?? []) as Array<Record<string, unknown>>).find((s) => Number(s.id) === connectionId);
    if (!src) throw new ToolError('That source is not in this workspace.');
    const products = (src.products ?? []) as unknown[];
    if (products.length) throw new ToolError(`${src.name} already has subjects — propose_new_subject adds one next to them.`);
    if (!Number(src.tableCount)) throw new ToolError(`Nothing has been synced from ${src.name} yet — sync it first (Studio › Sources).`);
    const plan = src.plan as { topics?: Array<{ name: string; description: string; kind: string }> } | null;
    const topics = (plan?.topics ?? []).map((t) => ({ name: t.name, description: clip(t.description, 200), shared: t.kind === 'reference' }));
    const proposal: CoworkerProposal = {
      id: randomUUID(), kind: 'first-build', connectionId, connectionName: String(src.name ?? `source ${connectionId}`),
      topics, fromTemplate: !!plan,
    };
    return {
      proposal,
      focus: { kind: 'source', connectionId },
      detail: topics.length ? `${topics.length} subject(s) planned` : 'designed by the AI',
      result: { proposed: true, planned_subjects: topics.map((t) => t.name) },
    };
  },
};

export const BUILD_TOOLS: CoworkerTool[] = [proposeRebuildTable, proposeFirstBuild];
