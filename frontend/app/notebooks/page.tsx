'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { getTokenPayload } from '@/lib/auth';

interface Notebook {
  id: number;
  title: string;
  description: string | null;
  connection_id: number | null;
  starred: boolean;
  cell_count: number;
  created_at: string;
  updated_at: string;
}

interface Connection {
  id: number;
  name: string;
}

export default function NotebooksPage() {
  const router = useRouter();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nbRes, connRes] = await Promise.all([
        api.get('/notebooks'),
        api.get('/connections'),
      ]);
      setNotebooks(nbRes.data.data ?? nbRes.data.items ?? []);
      setConnections(connRes.data.data ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createNotebook = async (connectionId?: number) => {
    setCreating(true);
    try {
      const res = await api.post('/notebooks', {
        title: 'Untitled Notebook',
        connectionId: connectionId ?? connections[0]?.id,
      });
      if (res.data.ok) {
        router.push(`/notebooks/${res.data.data.id}`);
      }
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  };

  const deleteNotebook = async (id: number) => {
    try {
      await api.delete(`/notebooks/${id}`);
      setNotebooks((prev) => prev.filter((n) => n.id !== id));
    } catch {
      // ignore
    }
  };

  const toggleStar = async (id: number) => {
    try {
      const res = await api.patch(`/notebooks/${id}/star`);
      if (res.data.ok) {
        setNotebooks((prev) =>
          prev.map((n) => (n.id === id ? { ...n, starred: res.data.data.starred } : n))
        );
      }
    } catch {
      // ignore
    }
  };

  const duplicateNotebook = async (id: number) => {
    try {
      const res = await api.post(`/notebooks/${id}/duplicate`);
      if (res.data.ok) {
        router.push(`/notebooks/${res.data.data.id}`);
      }
    } catch {
      // ignore
    }
  };

  const connName = (id: number | null) => {
    if (!id) return null;
    return connections.find((c) => c.id === id)?.name ?? null;
  };

  const formatDate = (d: string) => {
    const date = new Date(d);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    if (diff < 60_000) return 'Just now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };

  return (
    <div className="flex-1 overflow-auto bg-surface">
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-headline-md font-headline font-bold text-on-surface">Notebooks</h1>
            <p className="text-body-md text-on-surface-variant mt-1">
              Write SQL and Python to explore your data
            </p>
          </div>
          <button
            onClick={() => createNotebook()}
            disabled={creating || connections.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl gradient-primary text-on-primary text-label-lg font-semibold hover:opacity-90 disabled:opacity-50 transition-all shadow-glow-primary"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New Notebook
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="w-8 h-8 border-3 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        ) : notebooks.length === 0 ? (
          <EmptyState onCreate={() => createNotebook()} connections={connections} />
        ) : (
          <div className="grid gap-3">
            {notebooks.map((nb) => (
              <div
                key={nb.id}
                onClick={() => router.push(`/notebooks/${nb.id}`)}
                className="group flex items-center gap-4 p-4 bg-surface-container-lowest rounded-xl border border-outline-variant/10 hover:border-primary/20 hover:shadow-ambient cursor-pointer transition-all"
              >
                {/* Icon */}
                <div className="w-10 h-10 rounded-lg bg-violet-50 flex items-center justify-center flex-shrink-0">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                  </svg>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-title-md font-semibold text-on-surface truncate">{nb.title}</h3>
                    {nb.starred && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="#eab308" stroke="#eab308" strokeWidth="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    {connName(nb.connection_id) && (
                      <span className="text-label-sm text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded font-medium">
                        {connName(nb.connection_id)}
                      </span>
                    )}
                    <span className="text-label-sm text-on-surface-variant">
                      {nb.cell_count} cell{nb.cell_count !== 1 ? 's' : ''}
                    </span>
                    <span className="text-label-sm text-on-surface-variant/60">
                      {formatDate(nb.updated_at)}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => toggleStar(nb.id)}
                    className="p-1.5 rounded-lg hover:bg-surface-container-low transition-colors"
                    title={nb.starred ? 'Unstar' : 'Star'}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill={nb.starred ? '#eab308' : 'none'} stroke={nb.starred ? '#eab308' : 'currentColor'} strokeWidth="2">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                  </button>
                  <button
                    onClick={() => duplicateNotebook(nb.id)}
                    className="p-1.5 rounded-lg hover:bg-surface-container-low transition-colors text-on-surface-variant"
                    title="Duplicate"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  <button
                    onClick={() => deleteNotebook(nb.id)}
                    className="p-1.5 rounded-lg hover:bg-error-container/30 transition-colors text-on-surface-variant hover:text-error"
                    title="Delete"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ onCreate, connections }: { onCreate: () => void; connections: Connection[] }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-16 h-16 rounded-2xl bg-violet-50 flex items-center justify-center mb-4">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      </div>
      <h2 className="text-title-lg font-semibold text-on-surface mb-2">No notebooks yet</h2>
      <p className="text-body-md text-on-surface-variant mb-6 max-w-sm">
        Create a notebook to write SQL queries and Python scripts against your data sources.
      </p>
      {connections.length > 0 ? (
        <button
          onClick={onCreate}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl gradient-primary text-on-primary text-label-lg font-semibold hover:opacity-90 transition-all shadow-glow-primary"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Create your first notebook
        </button>
      ) : (
        <p className="text-body-sm text-on-surface-variant/60">Connect a data source first to start exploring.</p>
      )}
    </div>
  );
}
