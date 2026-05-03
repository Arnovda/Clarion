'use client';

import { X } from 'lucide-react';
import type { SourceTable, SourceColumn } from '@/components/semantic/types';
import RelationshipForm, { type RelationshipFormValue } from './RelationshipForm';
import { createRelationship } from './useSchema';

interface Props {
  tables:         SourceTable[];
  columnsByTable: Record<number, SourceColumn[]>;
  onClose:        () => void;
  onCreated:      () => void;
  /** Pre-populate from-side (used when invoked from a specific table). */
  initial?:       Partial<RelationshipFormValue>;
}

export default function AddRelationshipDialog({
  tables, columnsByTable, onClose, onCreated, initial,
}: Props) {
  return (
    <Modal title="Add relationship" onClose={onClose}>
      <RelationshipForm
        tables={tables}
        columnsByTable={columnsByTable}
        initial={initial}
        submitLabel="Create"
        onSubmit={async (v) => {
          await createRelationship(v);
          onCreated();
        }}
        onCancel={onClose}
      />
    </Modal>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[640px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-64px)] overflow-y-auto bg-raised border border-line rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h3 className="font-display text-[18px] tracking-[-0.01em] text-ink">{title}</h3>
          <button onClick={onClose} className="text-muted-2 hover:text-ink p-1 -mr-1" aria-label="Close">
            <X className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
