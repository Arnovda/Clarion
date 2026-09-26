/**
 * Keep and Undo for a coworker proposal — the ONLY place a proposal becomes
 * real, and only ever on a person's click.
 *
 * Every Keep calls the same routes the screens call, as the same user, so a
 * proposal is held to exactly the rules a hand-made change is. Keep returns
 * the calls that put things back (`undo`), recorded at the moment of the
 * change — the old text, the new row's id — so Undo is a replay, never a
 * guess about what used to be there.
 *
 * Two kinds need the panel itself after Keep (a new table's SQL arrives as a
 * next proposal; a build is followed at the top of the Catalog) — they are handled in the
 * provider, not here.
 */
import api from '@/lib/api';
import type { CoworkerDescriptionItem, CoworkerProposal } from '@/lib/contract';

export interface UndoCall {
  method: 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: unknown;
}

export interface KeepOutcome {
  /** Replayed in order by Undo. Absent = this change has no Undo. */
  undo?: UndoCall[];
  followHref?: string;
  followLabel?: string;
}

/** Where a description or display name is written, per kind of target. */
function descriptionPath(item: CoworkerDescriptionItem): string {
  switch (item.target) {
    case 'source-table': return `/semantic/tables/${item.id}`;
    case 'source-column': return `/semantic/columns/${item.id}`;
    case 'subject-table': return `/semantic/product-tables/${item.id}`;
    case 'subject-column': return `/semantic/product-columns/${item.id}`;
  }
}

export async function replay(calls: UndoCall[]): Promise<void> {
  for (const c of calls) {
    if (c.method === 'delete') await api.delete(c.path);
    else await api[c.method](c.path, c.body);
  }
}

export async function applyProposal(p: CoworkerProposal): Promise<KeepOutcome> {
  switch (p.kind) {
    case 'sql': {
      await api.put(`/products/tables/${p.tableId}/sql`, { sql: p.after });
      return p.before.trim() ? { undo: [{ method: 'put', path: `/products/tables/${p.tableId}/sql`, body: { sql: p.before } }] } : {};
    }
    case 'relationship': {
      const r = await api.post('/semantic/relationships', {
        from_table_id: p.fromTableId, from_column_id: p.fromColumnId,
        to_table_id: p.toTableId, to_column_id: p.toColumnId,
        relationship_type: p.measurement.cardinality?.type ?? 'many_to_one',
        description: p.reason, kind: 'join', measured: p.measurement,
      });
      return { undo: [{ method: 'delete', path: `/semantic/relationships/${Number(r.data?.data?.id)}` }] };
    }
    case 'glossary': {
      const r = await api.post('/semantic/glossary', { term: p.term, meaning: p.meaning, links: p.links });
      return { undo: [{ method: 'delete', path: `/semantic/glossary/${Number(r.data?.data?.id)}` }] };
    }
    case 'glossary-edit': {
      await api.patch(`/semantic/glossary/${p.termId}`, p.after);
      return { undo: [{ method: 'patch', path: `/semantic/glossary/${p.termId}`, body: p.before }] };
    }
    case 'descriptions': {
      // One at a time, so a refusal part-way leaves a clear record: what was
      // written is undone by the calls collected so far.
      const undo: UndoCall[] = [];
      try {
        for (const item of p.items) {
          const path = descriptionPath(item);
          await api.patch(path, { [item.field]: item.after });
          // A first description is undone to an empty text: the save routes
          // read null as "leave it", and the screens show '' as "none".
          undo.unshift({ method: 'patch', path, body: { [item.field]: item.before ?? '' } });
        }
      } catch (err) {
        if (undo.length) await replay(undo).catch(() => { /* reported by the outer error */ });
        throw err;
      }
      return { undo };
    }
    case 'metric': {
      if (p.kpiId === null) {
        const v = p.values;
        const r = await api.post(`/products/${p.productId}/kpis`, {
          name: v.name, description: v.description, formulaSql: v.formula_sql,
          formulaPlainText: v.formula_plain_text, questionText: v.question_text,
        });
        return { undo: [{ method: 'delete', path: `/products/kpis/${Number(r.data?.data?.id)}` }] };
      }
      // Read what is stored right before the write, so Undo restores exactly that.
      const list = ((await api.get(`/products/${p.productId}/kpis`)).data?.data ?? []) as Array<Record<string, unknown>>;
      const cur = list.find((k) => Number(k.id) === p.kpiId);
      if (!cur) throw new Error('This metric no longer exists.');
      const before = {
        name: cur.name, description: cur.description ?? null, formula_sql: cur.formula_sql ?? null,
        formula_plain_text: cur.formula_plain_text ?? null, question_text: cur.question_text ?? null,
      };
      await api.put(`/products/kpis/${p.kpiId}`, p.values);
      return { undo: [{ method: 'put', path: `/products/kpis/${p.kpiId}`, body: before }] };
    }
    case 'relationship-review': {
      if (p.action === 'confirm') {
        await api.patch(`/semantic/relationships/${p.relationshipId}`, {
          ...(p.relationshipType ? { relationship_type: p.relationshipType } : {}),
          ...(p.measurement ? { measured: p.measurement } : {}),
        });
        // Confirming has no inverse route: a confirmed link is flagged if it
        // turns out wrong, and the card says so.
        return {};
      }
      const flagged = p.action === 'flag';
      await api.post(`/relationships/${p.relationshipId}/flag`, { flagged, reason: flagged ? p.reason : null });
      return { undo: [{ method: 'post', path: `/relationships/${p.relationshipId}/flag`, body: { flagged: !flagged, reason: flagged ? null : p.reason } }] };
    }
    case 'rebuild': {
      await api.post(`/products/tables/${p.tableId}/run`);
      return {};
    }
    case 'first-build': {
      await api.post('/products/bus-matrix/start', { connectionId: p.connectionId });
      return { followHref: '/catalog', followLabel: 'Follow the build' };
    }
    case 'grid-new': {
      const r = await api.post('/grids', {
        name: p.name, kind: p.gridKind, description: p.description,
        columns: p.columns.map((c) => ({ name: c.name, type: c.type, link: c.link ?? null })),
      });
      const grid = r.data?.data as { id: number; columns: Array<{ key: string; link?: { table: string; column: string } | null }> };
      const linked = p.seedFromLink ? grid.columns.find((c) => c.link) : undefined;
      if (linked?.link) {
        const v = await api.get('/grids/link-values', { params: { table: linked.link.table, column: linked.link.column } });
        const values = (v.data?.data?.values ?? []) as string[];
        if (values.length) await api.put(`/grids/${grid.id}/rows`, { rows: values.map((x) => ({ data: { [linked.key]: x } })) });
      }
      return {
        undo: [{ method: 'delete', path: `/grids/${grid.id}` }],
        followHref: `/grids/${grid.id}`, followLabel: 'Open it',
      };
    }
    case 'grid-rows': {
      // A full-replacement save must not overwrite an edit it did not see.
      const cur = (await api.get(`/grids/${p.gridId}`)).data?.data as { updatedAt?: string | null };
      if (p.baseUpdatedAt && cur?.updatedAt && String(cur.updatedAt) !== p.baseUpdatedAt) {
        throw new Error('This table was edited since the proposal — ask again so it starts from what is there now.');
      }
      await api.put(`/grids/${p.gridId}/rows`, { rows: p.rowsAfter.map((data) => ({ data })) });
      return {
        undo: [{ method: 'put', path: `/grids/${p.gridId}/rows`, body: { rows: p.rowsBefore.map((data) => ({ data })) } }],
        followHref: `/grids/${p.gridId}`, followLabel: 'Open it',
      };
    }
    case 'table':
    case 'subject':
      throw new Error(`${p.kind} proposals are kept by the panel`);
  }
}
