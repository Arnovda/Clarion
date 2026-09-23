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
import type { FullDataProduct, ProductTable } from '@/components/products/types';
import type { CatalogNavTarget } from './navigation';

const StarSchemaFlow = dynamic(() => import('@/components/products/StarSchemaFlow'), { ssr: false });

type Schema = FullDataProduct['star_schemas'][number];

/** Cardinality in words — the diagram's 1 / ∗ ends, said. */
const RELATION_WORDS: Record<string, string> = {
  many_to_one: 'many to one',
  one_to_many: 'one to many',
  one_to_one: 'one to one',
  many_to_many: 'many to many',
};

function labelOf(t: ProductTable | undefined, fallback: string): string {
  if (t?.display_name) return t.display_name;
  const raw = t?.table_name ?? fallback;
  return raw.replace(/^(dim|fact|bridge|junk)_/, '').replace(/_+/g, ' ');
}

function TableName({ table, fallback, onNavigate }: {
  table: ProductTable | undefined;
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

/** The joins of one star, as a list. `curator` adds the column each end joins on. */
export function JoinsList({ schema, focusTableName, curator, onNavigate }: {
  schema: Schema;
  focusTableName?: string | null;
  curator: boolean;
  onNavigate?: (target: CatalogNavTarget) => void;
}) {
  const byName = useMemo(() => new Map(schema.tables.map((t) => [t.table_name, t])), [schema.tables]);
  const rels = focusTableName
    ? schema.relationships.filter((r) => r.from_table_name === focusTableName || r.to_table_name === focusTableName)
    : schema.relationships;

  if (rels.length === 0) {
    return (
      <p className="text-[13px] text-muted italic">
        {focusTableName ? 'This table joins to nothing yet.' : 'Nothing joins yet — the subject has no relationships recorded.'}
      </p>
    );
  }
  return (
    <ul className="bg-raised border border-line rounded-lg divide-y divide-line">
      {rels.map((r) => {
        const from = byName.get(r.from_table_name);
        const to = byName.get(r.to_table_name);
        return (
          <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-[13px]">
            <TableName table={from} fallback={r.from_table_name} onNavigate={onNavigate} />
            {curator && <span className="font-mono text-[11px] text-muted-2">.{r.from_column_name}</span>}
            <span className="text-muted-2" aria-hidden>→</span>
            <TableName table={to} fallback={r.to_table_name} onNavigate={onNavigate} />
            {curator && <span className="font-mono text-[11px] text-muted-2">.{r.to_column_name}</span>}
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

  const schemas = focusTableName
    ? fetched.star_schemas.filter((s) => s.tables.some((t) => t.table_name === focusTableName))
    : fetched.star_schemas;
  if (schemas.length === 0) {
    return <p className="text-[13px] text-muted italic">Nothing has been designed for this subject yet.</p>;
  }

  return (
    <div className="space-y-6">
      {schemas.map((schema) => (
        <section key={schema.id} className="space-y-3">
          {/* The diagram draws the join columns by name — a curator's view. */}
          {curator && <StarSchemaFlow schema={schema} />}
          <div>
            <h3 className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 font-medium mb-2">
              {focusTableName ? 'Joins' : `Joins · ${schema.relationships.length}`}
            </h3>
            <JoinsList schema={schema} focusTableName={focusTableName} curator={curator} onNavigate={onNavigate} />
          </div>
        </section>
      ))}
    </div>
  );
}
