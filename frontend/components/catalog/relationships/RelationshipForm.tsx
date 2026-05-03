'use client';

/**
 * <RelationshipForm> — shared form body used by Add and Edit dialogs.
 *
 * Four selects laid out as a single line (from-table.from-column → to-table.to-column),
 * a type chooser, and an optional description. Returns the chosen values on submit.
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import type { SourceTable, SourceColumn } from '@/components/semantic/types';
import { cn } from '@/lib/cn';

export interface RelationshipFormValue {
  from_table_id:  number;
  from_column_id: number | null;
  to_table_id:    number;
  to_column_id:   number | null;
  relationship_type: string;
  description?: string | null;
}

const TYPES: Array<{ id: string; label: string; hint: string }> = [
  { id: 'many_to_one',  label: 'Many → One',  hint: 'Multiple rows in this table point to one row in the other (most common — e.g. invoices to a customer)' },
  { id: 'one_to_many',  label: 'One → Many',  hint: 'Inverse of many-to-one (rarely needed; usually pick the other side instead)' },
  { id: 'one_to_one',   label: 'One → One',   hint: 'Each row pairs with exactly one row on the other side (e.g. an order and its shipment record)' },
  { id: 'many_to_many', label: 'Many ↔ Many', hint: 'Both sides can match many rows (usually means a join table is missing)' },
];

interface Props {
  tables:         SourceTable[];
  columnsByTable: Record<number, SourceColumn[]>;
  initial?:       Partial<RelationshipFormValue>;
  /** Disable changing from/to tables (used in edit mode). */
  lockTables?:    boolean;
  onSubmit:       (value: RelationshipFormValue) => Promise<void> | void;
  onCancel:       () => void;
  submitLabel?:   string;
  /** Optional secondary action (used by Edit dialog for Delete). */
  secondaryAction?: { label: string; onClick: () => void; variant?: 'danger' };
}

export default function RelationshipForm({
  tables, columnsByTable, initial, lockTables,
  onSubmit, onCancel, submitLabel = 'Save', secondaryAction,
}: Props) {
  const [fromTable, setFromTable] = useState<number | null>(initial?.from_table_id ?? null);
  const [fromCol,   setFromCol]   = useState<number | null>(initial?.from_column_id ?? null);
  const [toTable,   setToTable]   = useState<number | null>(initial?.to_table_id   ?? null);
  const [toCol,     setToCol]     = useState<number | null>(initial?.to_column_id  ?? null);
  const [type,      setType]      = useState<string>(initial?.relationship_type ?? 'many_to_one');
  const [desc,      setDesc]      = useState<string>(initial?.description ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset col selection if table changes (and the chosen col belongs to a different table).
  useEffect(() => {
    if (fromTable && fromCol && !columnsByTable[fromTable]?.some((c) => c.id === fromCol)) {
      setFromCol(null);
    }
  }, [fromTable, fromCol, columnsByTable]);
  useEffect(() => {
    if (toTable && toCol && !columnsByTable[toTable]?.some((c) => c.id === toCol)) {
      setToCol(null);
    }
  }, [toTable, toCol, columnsByTable]);

  const sortedTables = useMemo(
    () => tables.slice().sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [tables],
  );

  const fromCols = fromTable
    ? (columnsByTable[fromTable] ?? []).slice().sort((a, b) => a.column_name.localeCompare(b.column_name))
    : [];
  const toCols = toTable
    ? (columnsByTable[toTable] ?? []).slice().sort((a, b) => a.column_name.localeCompare(b.column_name))
    : [];

  const valid = !!(fromTable && toTable && type);

  async function handleSubmit() {
    if (!valid || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        from_table_id:     fromTable!,
        from_column_id:    fromCol,
        to_table_id:       toTable!,
        to_column_id:      toCol,
        relationship_type: type,
        description:       desc.trim() || null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Tables + columns row */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
        <Picker
          label="From table"
          value={fromTable}
          onChange={setFromTable}
          options={sortedTables.map((t) => ({ id: t.id, label: t.display_name, hint: t.table_name }))}
          disabled={lockTables}
        />
        <div className="pb-2 text-muted-2"><ArrowRight className="w-4 h-4" strokeWidth={2} /></div>
        <Picker
          label="To table"
          value={toTable}
          onChange={setToTable}
          options={sortedTables.map((t) => ({ id: t.id, label: t.display_name, hint: t.table_name }))}
          disabled={lockTables}
        />

        <Picker
          label="From column (optional)"
          value={fromCol}
          onChange={setFromCol}
          options={fromCols.map((c) => ({ id: c.id, label: c.column_name, hint: c.data_type }))}
          placeholder={fromTable ? '— any column —' : 'Pick a from-table first'}
          allowEmpty
        />
        <div />
        <Picker
          label="To column (optional)"
          value={toCol}
          onChange={setToCol}
          options={toCols.map((c) => ({ id: c.id, label: c.column_name, hint: c.data_type }))}
          placeholder={toTable ? '— any column —' : 'Pick a to-table first'}
          allowEmpty
        />
      </div>

      {/* Type chooser */}
      <div>
        <label className="block text-[11px] font-mono uppercase tracking-[0.08em] text-muted mb-1.5">
          Relationship type
        </label>
        <div className="grid grid-cols-2 gap-2">
          {TYPES.map(({ id, label, hint }) => (
            <button
              key={id}
              type="button"
              onClick={() => setType(id)}
              className={cn(
                'text-left px-3 py-2 rounded-md border text-[12.5px] transition',
                type === id
                  ? 'border-ocean bg-ocean-softer'
                  : 'border-line bg-raised hover:border-line-strong',
              )}
            >
              <div className="font-mono uppercase tracking-[0.06em] text-[11px] text-ink">{label}</div>
              <div className="text-[11px] text-muted mt-0.5 leading-relaxed">{hint}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Description */}
      <div>
        <label className="block text-[11px] font-mono uppercase tracking-[0.08em] text-muted mb-1.5">
          Description (optional)
        </label>
        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="e.g. Each invoice is billed to a customer"
          className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-ocean-soft focus:ring-1 focus:ring-ocean-soft"
        />
      </div>

      {error && (
        <div className="text-[12px] text-warn bg-warn-soft border border-line rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        {secondaryAction && (
          <button
            type="button"
            onClick={secondaryAction.onClick}
            disabled={submitting}
            className={cn(
              'mr-auto px-3 py-1.5 text-[12px] font-mono uppercase tracking-[0.06em] rounded-md border transition disabled:opacity-50',
              secondaryAction.variant === 'danger'
                ? 'text-warn border-line hover:bg-warn-soft'
                : 'text-ink-2 border-line hover:bg-softer',
            )}
          >
            {secondaryAction.label}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-3 py-1.5 text-[12px] font-mono uppercase tracking-[0.06em] text-ink-2 border border-line rounded-md hover:bg-softer transition disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!valid || submitting}
          className="px-3 py-1.5 text-[12px] font-mono uppercase tracking-[0.06em] text-white bg-ocean rounded-md hover:bg-ocean-hover transition disabled:opacity-50"
        >
          {submitting ? 'Saving…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

interface PickerProps {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  options: Array<{ id: number; label: string; hint?: string }>;
  placeholder?: string;
  allowEmpty?: boolean;
  disabled?: boolean;
}

function Picker({ label, value, onChange, options, placeholder, allowEmpty, disabled }: PickerProps) {
  return (
    <div>
      <label className="block text-[11px] font-mono uppercase tracking-[0.08em] text-muted mb-1.5">
        {label}
      </label>
      <select
        value={value ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === '' ? null : Number(v));
        }}
        disabled={disabled}
        className={cn(
          'w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-ocean-soft focus:ring-1 focus:ring-ocean-soft',
          disabled && 'opacity-60 cursor-not-allowed',
        )}
      >
        {(allowEmpty || value === null) && (
          <option value="">{placeholder ?? '— select —'}</option>
        )}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}{o.hint ? `  ·  ${o.hint}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
