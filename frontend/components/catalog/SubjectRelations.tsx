'use client';

/**
 * <SubjectRelations> — how a subject's tables join, on the catalog.
 *
 * Owner (2026-09-23): "Add relations to the catalog tab as well please next
 * to lineage." Curators get the star diagram — <StarSchemaFlow>, the same
 * drawing the topic's Manage mode called "How it fits together" — and
 * everyone gets the joins as a LIST in display names, so a viewer reads
 * "Payments → Account · many to one" and never a key column. With
 * `focusTableName` the list is that table's joins and the diagram is the
 * star it sits in — the table panel's Relations tab.
 *
 * The data is GET /products/:id (tables with their join columns, the
 * relationships per star); a caller that already holds it passes `detail`.
 */
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import api from '@/lib/api';
import type { FullDataProduct, ProductColumn, ProductRelationship, ProductTable } from '@/components/products/types';
import type { CatalogNavTarget } from './navigation';

const StarSchemaFlow = dynamic(() => import('@/components/products/StarSchemaFlow'), { ssr: false });

type Schema = FullDataProduct['star_schemas'][number];

/** A table as this view needs it — a subject's own, or one another subject holds. */
type ViewTable = Pick<ProductTable, 'id' | 'table_name' | 'display_name' | 'description' | 'table_role'> & {
  columns: ProductColumn[];
  join_columns?: ProductColumn[];
  /** Set on a table another subject holds: its subject's name. */
  subject_name?: string;
};
type ViewRel = ProductRelationship & {
  /** Set on a join recorded in another subject: that subject's name. */
  in_subject_name?: string;
  key: string;
};
interface ViewSchema {
  id: number;
  name: string;
  description: string | null;
  grain: string | null;
  tables: ViewTable[];
  relationships: ViewRel[];
}

/**
 * A star plus the joins its tables take part in ELSEWHERE. A shared lookup's
 * joins are recorded in the subjects that use it (Sales joins its copy of
 * Item), so the star alone says Item "joins to nothing yet" — the most-joined
 * table there is. The payload's `external_joins` carries those joins and the
 * tables on their far end; they are added here to the star whose table they
 * touch.
 */
function withExternal(schema: Schema, detail: FullDataProduct): ViewSchema {
  const ownIds = new Set(schema.tables.map((t) => t.id));
  const ext = detail.external_joins;
  const extRels = (ext?.relationships ?? []).filter((r) => ownIds.has(r.own_table_id));
  const farIds = new Set(extRels.map((r) => r.other_table_id).filter((id): id is number => id != null));
  const farTables: ViewTable[] = (ext?.tables ?? [])
    .filter((t) => farIds.has(t.id) && !schema.tables.some((own) => own.table_name === t.table_name))
    .map((t) => ({ ...t, subject_name: t.subject_name }));
  return {
    id: schema.id,
    name: schema.name,
    description: schema.description ?? null,
    grain: schema.grain ?? null,
    tables: [...schema.tables, ...farTables],
    relationships: [
      ...schema.relationships.map((r) => ({ ...r, key: `own-${r.id}` })),
      ...extRels.map((r) => ({
        id: r.id,
        from_table_name: r.from_table_name, from_column_name: r.from_column_name,
        to_table_name: r.to_table_name, to_column_name: r.to_column_name,
        relationship_type: r.relationship_type,
        in_subject_name: r.in_subject_name,
        key: `ext-${r.id}`,
      })),
    ],
  };
}

/** Cardinality in words — the diagram's 1 / ∗ ends, said. */
const RELATION_WORDS: Record<string, string> = {
  many_to_one: 'many to one',
  one_to_many: 'one to many',
  one_to_one: 'one to one',
  many_to_many: 'many to many',
};

function labelOf(t: ViewTable | undefined, fallback: string): string {
  if (t?.display_name) return t.display_name;
  const raw = t?.table_name ?? fallback;
  return raw.replace(/^(dim|fact|bridge|junk)_/, '').replace(/_+/g, ' ');
}

function TableName({ table, fallback, onNavigate }: {
  table: ViewTable | undefined;
  fallback: string;
  onNavigate?: (target: CatalogNavTarget) => void;
}) {
  const label = labelOf(table, fallback);
  if (!table || !onNavigate) return <span className="font-medium text-ink">{label}</span>;
  return (
    <button
      type="button"
      onClick={() => onNavigate({ kind: 'table', tableId: table.id })}
      className="font-medium text-ink hover:text-ocean transition-colors text-left"
    >
      {label}
    </button>
  );
}

/** Joins as a list. `curator` adds the column each end joins on. */
export function JoinsList({ tables, relationships, curator, onNavigate, empty }: {
  tables: ViewTable[];
  relationships: ViewRel[];
  curator: boolean;
  onNavigate?: (target: CatalogNavTarget) => void;
  empty: string;
}) {
  const byName = useMemo(() => new Map(tables.map((t) => [t.table_name, t])), [tables]);
  if (relationships.length === 0) {
    return <p className="text-[13px] text-muted italic">{empty}</p>;
  }
  return (
    <ul className="bg-raised border border-line rounded-lg divide-y divide-line">
      {relationships.map((r) => {
        const from = byName.get(r.from_table_name);
        const to = byName.get(r.to_table_name);
        return (
          <li key={r.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-[13px]">
            <TableName table={from} fallback={r.from_table_name} onNavigate={onNavigate} />
            {curator && <span className="font-mono text-[11px] text-muted-2">.{r.from_column_name}</span>}
            <span className="text-muted-2" aria-hidden>→</span>
            <TableName table={to} fallback={r.to_table_name} onNavigate={onNavigate} />
            {curator && <span className="font-mono text-[11px] text-muted-2">.{r.to_column_name}</span>}
            {r.in_subject_name && (
              <span className="rounded-full bg-soft px-2 py-[1px] text-[11px] text-muted" title={`This join is recorded in ${r.in_subject_name}, which uses the table`}>
                in {r.in_subject_name}
              </span>
            )}
            <span className="ml-auto text-[10.5px] font-mono uppercase tracking-[0.08em] text-muted-2 whitespace-nowrap">
              {RELATION_WORDS[r.relationship_type] ?? r.relationship_type.replace(/_/g, ' ')}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function SubjectRelations({ productId, detail, focusTableName, curator, onNavigate }: {
  productId: number;
  /** The GET /products/:id payload, when the caller already holds it. */
  detail?: FullDataProduct | null;
  /** A table's own Relations tab: its joins, in its star. */
  focusTableName?: string | null;
  curator: boolean;
  onNavigate?: (target: CatalogNavTarget) => void;
}) {
  const [fetched, setFetched] = useState<FullDataProduct | null | undefined>(detail ? detail : undefined);
  useEffect(() => {
    if (detail) { setFetched(detail); return; }
    let cancelled = false;
    api.get(`/products/${productId}`)
      .then((r) => { if (!cancelled) setFetched((r.data?.data ?? null) as FullDataProduct | null); })
      .catch(() => { if (!cancelled) setFetched(null); });
    return () => { cancelled = true; };
  }, [productId, detail]);

  if (fetched === undefined) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2} aria-hidden /> Loading the relationships…
      </div>
    );
  }
  if (fetched === null) return <p className="text-[13px] text-err">Could not load this subject&apos;s relationships.</p>;

  const detailData = fetched;
  const views = detailData.star_schemas.map((sc) => withExternal(sc, detailData));
  const eyebrow = 'text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 font-medium mb-2';

  // ── One table's Relations tab: that table in the centre, every join to it
  //    — including the ones recorded in the subjects that use it.
  if (focusTableName) {
    const view = views.find((v) => v.tables.some((t) => t.table_name === focusTableName));
    if (!view) return <p className="text-[13px] text-muted italic">Nothing has been designed for this subject yet.</p>;
    const rels = view.relationships.filter((r) => r.from_table_name === focusTableName || r.to_table_name === focusTableName);
    const nearNames = new Set<string>([focusTableName]);
    for (const r of rels) { nearNames.add(r.from_table_name); nearNames.add(r.to_table_name); }
    const focus = view.tables.find((t) => t.table_name === focusTableName);
    const focused: ViewSchema = { ...view, name: labelOf(focus, focusTableName), tables: view.tables.filter((t) => nearNames.has(t.table_name)), relationships: rels };
    const usedElsewhere = rels.some((r) => r.in_subject_name);
    return (
      <div className="space-y-3">
        {curator && rels.length > 0 && (
          <StarSchemaFlow
            schema={focused}
            anchorTableName={focusTableName}
            subtitle={usedElsewhere
              ? `Everything ${labelOf(focus, focusTableName)} joins to, including the subjects that use it.`
              : `Everything ${labelOf(focus, focusTableName)} joins to.`}
          />
        )}
        <div>
          <h3 className={eyebrow}>{`Joins · ${rels.length}`}</h3>
          <JoinsList tables={focused.tables} relationships={rels} curator={curator} onNavigate={onNavigate} empty="This table joins to nothing yet." />
        </div>
      </div>
    );
  }

  // ── A subject's Relations tab: each star as designed, then the joins its
  //    tables take part in elsewhere (a Reference subject's whole story).
  if (views.length === 0) {
    return <p className="text-[13px] text-muted italic">Nothing has been designed for this subject yet.</p>;
  }
  const ownOf = (v: ViewSchema) => v.relationships.filter((r) => !r.in_subject_name);
  const extOf = (v: ViewSchema) => v.relationships.filter((r) => r.in_subject_name);
  const anyOwn = views.some((v) => ownOf(v).length > 0);
  const allTables = views.flatMap((v) => v.tables);
  const allExt = views.flatMap(extOf);
  return (
    <div className="space-y-6">
      {views.map((view) => {
        const own = ownOf(view);
        // A star with no joins of its own (a subject of shared lookups) draws
        // nothing but unconnected cards — its joins are listed below instead.
        if (own.length === 0 && (anyOwn || allExt.length > 0)) return null;
        const star: ViewSchema = { ...view, tables: view.tables.filter((t) => !t.subject_name), relationships: own };
        return (
          <section key={view.id} className="space-y-3">
            {/* The diagram draws the join columns by name — a curator's view. */}
            {curator && own.length > 0 && <StarSchemaFlow schema={star} />}
            {(own.length > 0 || allExt.length === 0) && (
              <div>
                <h3 className={eyebrow}>{`Joins · ${own.length}`}</h3>
                <JoinsList tables={star.tables} relationships={own} curator={curator} onNavigate={onNavigate} empty="Nothing joins yet — the subject has no relationships recorded." />
              </div>
            )}
          </section>
        );
      })}
      {allExt.length > 0 && (
        <section>
          <h3 className={eyebrow}>{`Used by other subjects · ${allExt.length}`}</h3>
          {!anyOwn && (
            <p className="text-[12.5px] text-muted mb-2">
              The tables here are shared lookups: they join where they are used. Open one to see its joins drawn.
            </p>
          )}
          <JoinsList tables={allTables} relationships={allExt} curator={curator} onNavigate={onNavigate} empty="" />
        </section>
      )}
    </div>
  );
}
