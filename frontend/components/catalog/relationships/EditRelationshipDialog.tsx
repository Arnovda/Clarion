'use client';

import { X } from 'lucide-react';
import type { SourceTable, SourceColumn } from '@/components/semantic/types';
import RelationshipForm from './RelationshipForm';
import {
  patchRelationship, deleteRelationship,
  type RelationshipRow,
} from './useSchema';

interface Props {
  relationship:   RelationshipRow;
  tables:         SourceTable[];
  columnsByTable: Record<number, SourceColumn[]>;
  onClose:        () => void;
  onSaved:        () => void;
  onDeleted:      () => void;
}

export default function EditRelationshipDialog({
  relationship, tables, columnsByTable, onClose, onSaved, onDeleted,
}: Props) {
  return (
    <Modal title={relationship.ai_draft ? 'Review AI draft relationship' : 'Edit relationship'} onClose={onClose}>
      <RelationshipForm
        tables={tables}
        columnsByTable={columnsByTable}
        lockTables
        initial={{
          from_table_id:     relationship.from_table_id,
          from_column_id:    relationship.from_column_id,
          to_table_id:       relationship.to_table_id,
          to_column_id:      relationship.to_column_id,
          relationship_type: relationship.relationship_type,
          description:       relationship.description,
        }}
        submitLabel={relationship.ai_draft ? 'Confirm & save' : 'Save'}
        onSubmit={async (v) => {
          await patchRelationship(relationship.id, {
            relationship_type: v.relationship_type,
            description:       v.description ?? null,
            from_column_id:    v.from_column_id,
            to_column_id:      v.to_column_id,
          });
          onSaved();
        }}
        onCancel={onClose}
        secondaryAction={{
          label: 'Delete',
          variant: 'danger',
          onClick: async () => {
            if (!confirm(`Delete this relationship?\n\n${relationship.from_table}.${relationship.from_column ?? '?'} → ${relationship.to_table}.${relationship.to_column ?? '?'}`)) return;
            await deleteRelationship(relationship.id);
            onDeleted();
          },
        }}
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
