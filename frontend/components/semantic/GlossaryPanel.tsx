'use client';

import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, BookOpen, Check, X, Search } from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';

export interface GlossaryEntry {
  id: number;
  term: string;
  meaning: string;
  examples: string[];
  tags: string[];
  ai_draft: boolean;
  created_at?: string;
  updated_at?: string;
}

const BLANK = { term: '', meaning: '', examplesText: '', tagsText: '' };

interface DraftForm {
  term: string;
  meaning: string;
  examplesText: string; // newline-separated for editing
  tagsText: string;     // comma-separated for editing
}

function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseTags(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function GlossaryPanel({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding]   = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm]       = useState<DraftForm>(BLANK);
  const [saving, setSaving]   = useState(false);
  const [search, setSearch]   = useState('');

  async function load() {
    try {
      setLoading(true);
      const { data } = await api.get('/semantic/glossary');
      if (data?.ok) setEntries(data.data ?? []);
    } catch {
      toast.error('Failed to load glossary');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function startAdd() {
    setEditingId(null);
    setForm(BLANK);
    setAdding(true);
  }

  function startEdit(e: GlossaryEntry) {
    setAdding(false);
    setEditingId(e.id);
    setForm({
      term: e.term,
      meaning: e.meaning,
      examplesText: e.examples.join('\n'),
      tagsText: e.tags.join(', '),
    });
  }

  function cancelEdit() {
    setAdding(false);
    setEditingId(null);
    setForm(BLANK);
  }

  async function save() {
    const term    = form.term.trim();
    const meaning = form.meaning.trim();
    if (!term || !meaning) {
      toast.error('Term and meaning are required');
      return;
    }
    const payload = {
      term,
      meaning,
      examples: parseLines(form.examplesText),
      tags:     parseTags(form.tagsText),
    };
    setSaving(true);
    try {
      if (editingId != null) {
        await api.patch(`/semantic/glossary/${editingId}`, payload);
        toast.success('Glossary entry updated');
      } else {
        await api.post('/semantic/glossary', payload);
        toast.success('Glossary entry added');
      }
      cancelEdit();
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error ?? 'Failed to save glossary entry');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (!confirm('Delete this glossary entry?')) return;
    try {
      await api.delete(`/semantic/glossary/${id}`);
      toast.success('Entry deleted');
      await load();
    } catch {
      toast.error('Failed to delete entry');
    }
  }

  const q = search.trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) =>
        e.term.toLowerCase().includes(q) ||
        e.meaning.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q)),
      )
    : entries;

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 bg-bg">
      <div className="max-w-3xl mx-auto space-y-4">
        {/* Heading */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">Tenant glossary</p>
            <h2 className="font-serif text-[22px] text-ink leading-tight mt-0.5">Business definitions & abbreviations</h2>
            <p className="text-[13px] text-muted mt-1.5 max-w-xl">
              Company-specific terms, abbreviations, and jargon. The AI uses these as extra context when generating
              SQL, dashboards, and definitions — so &ldquo;QTD revenue&rdquo; or &ldquo;Net New ARR&rdquo; resolves
              to whatever you mean by it.
            </p>
          </div>
          {canEdit && (
            <button
              onClick={startAdd}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
            >
              <Plus className="w-4 h-4" /> Add term
            </button>
          )}
        </div>

        {/* Search */}
        {entries.length > 0 && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search terms, meanings, tags…"
              className="w-full pl-9 pr-3 py-2 text-[13px] bg-raised border border-line rounded-md text-ink placeholder:text-muted-2 focus:outline-none focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)] transition-colors"
            />
          </div>
        )}

        {/* Add form */}
        {adding && canEdit && (
          <EntryForm
            form={form}
            setForm={setForm}
            saving={saving}
            onSave={save}
            onCancel={cancelEdit}
            mode="new"
          />
        )}

        {/* List */}
        {loading ? (
          <div className="text-[13px] text-muted py-8 text-center">Loading glossary…</div>
        ) : filtered.length === 0 && !adding ? (
          <div className="bg-raised border border-line rounded-xl p-10 text-center">
            <BookOpen className="w-7 h-7 text-muted-2 mx-auto mb-2" />
            <p className="text-[13px] text-muted">
              {entries.length === 0
                ? 'No glossary entries yet. Add abbreviations or company-specific wordings so the AI knows what they mean.'
                : 'No entries match your search.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {filtered.map((e) =>
              editingId === e.id ? (
                <EntryForm
                  key={e.id}
                  form={form}
                  setForm={setForm}
                  saving={saving}
                  onSave={save}
                  onCancel={cancelEdit}
                  mode="edit"
                />
              ) : (
                <div
                  key={e.id}
                  className="group bg-raised border border-line rounded-lg p-4 hover:border-line-strong transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="font-mono text-[13px] font-semibold text-ink">{e.term}</span>
                        {e.tags.map((t) => (
                          <span
                            key={t}
                            className="font-mono text-[10px] uppercase tracking-[0.05em] px-1.5 py-0.5 rounded bg-softer text-muted"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                      <p className="text-[13px] text-ink-2 mt-1 leading-snug">{e.meaning}</p>
                      {e.examples.length > 0 && (
                        <ul className="mt-2 space-y-0.5">
                          {e.examples.map((ex, i) => (
                            <li key={i} className="text-[12px] text-muted">
                              <span className="text-muted-2">·</span> <span className="italic">{ex}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {canEdit && (
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => startEdit(e)}
                          className="p-1.5 rounded text-muted hover:text-ink hover:bg-softer transition-colors"
                          title="Edit"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => remove(e.id)}
                          className="p-1.5 rounded text-muted hover:text-err hover:bg-softer transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EntryForm({
  form,
  setForm,
  saving,
  onSave,
  onCancel,
  mode,
}: {
  form: DraftForm;
  setForm: (f: DraftForm) => void;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  mode: 'new' | 'edit';
}) {
  return (
    <div className="bg-raised border border-ocean/40 rounded-lg p-4 space-y-3 shadow-sm">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">
        {mode === 'new' ? 'New glossary entry' : 'Edit glossary entry'}
      </p>
      <div>
        <label className="block font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-1.5">Term</label>
        <input
          autoFocus
          value={form.term}
          onChange={(e) => setForm({ ...form, term: e.target.value })}
          placeholder="e.g. QTD, EBITDA, Net New ARR"
          className="w-full px-3 py-1.5 text-[13px] bg-bg border border-line rounded-md text-ink focus:outline-none focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)] transition-colors"
        />
      </div>
      <div>
        <label className="block font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-1.5">Meaning</label>
        <textarea
          value={form.meaning}
          onChange={(e) => setForm({ ...form, meaning: e.target.value })}
          placeholder="What this term means in your business"
          rows={2}
          className="w-full px-3 py-1.5 text-[13px] bg-bg border border-line rounded-md text-ink focus:outline-none focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)] transition-colors resize-none"
        />
      </div>
      <div>
        <label className="block font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-1.5">
          Examples <span className="lowercase tracking-normal">(one per line, optional)</span>
        </label>
        <textarea
          value={form.examplesText}
          onChange={(e) => setForm({ ...form, examplesText: e.target.value })}
          placeholder={'"Show me QTD revenue"\n"How much QTD did we close?"'}
          rows={2}
          className="w-full px-3 py-1.5 text-[13px] font-mono bg-bg border border-line rounded-md text-ink focus:outline-none focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)] transition-colors resize-none"
        />
      </div>
      <div>
        <label className="block font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-1.5">
          Tags <span className="lowercase tracking-normal">(comma-separated, optional)</span>
        </label>
        <input
          value={form.tagsText}
          onChange={(e) => setForm({ ...form, tagsText: e.target.value })}
          placeholder="finance, sales, time-period"
          className="w-full px-3 py-1.5 text-[13px] bg-bg border border-line rounded-md text-ink focus:outline-none focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)] transition-colors"
        />
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onSave}
          disabled={saving || !form.term.trim() || !form.meaning.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors"
        >
          <Check className="w-4 h-4" />
          {saving ? 'Saving…' : mode === 'new' ? 'Save term' : 'Save changes'}
        </button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium border border-line text-ink-2 rounded-md hover:bg-softer transition-colors"
        >
          <X className="w-4 h-4" /> Cancel
        </button>
      </div>
    </div>
  );
}
