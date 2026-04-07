'use client';

import { useState, useRef } from 'react';
import api from '@/lib/api';

interface Props {
  connectionId: number;
  onClose: () => void;
  onImported: () => void;
}

interface ParsedRow {
  table_name: string;
  column_name?: string;
  display_name?: string;
  description?: string;
  is_dimension?: boolean;
  is_measure?: boolean;
  domains?: string[];
  grain?: string;
}

function parseCSV(text: string): ParsedRow[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/['"]/g, ''));
  const rows: ParsedRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map((v) => v.trim().replace(/^["']|["']$/g, ''));
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ''; });

    if (!row.table_name) continue;

    const parsed: ParsedRow = { table_name: row.table_name };
    if (row.column_name) parsed.column_name = row.column_name;
    if (row.display_name) parsed.display_name = row.display_name;
    if (row.description) parsed.description = row.description;
    if (row.is_dimension) parsed.is_dimension = row.is_dimension.toLowerCase() === 'true' || row.is_dimension === '1';
    if (row.is_measure) parsed.is_measure = row.is_measure.toLowerCase() === 'true' || row.is_measure === '1';
    if (row.domains) parsed.domains = row.domains.split(';').map((d) => d.trim()).filter(Boolean);
    if (row.grain) parsed.grain = row.grain;

    rows.push(parsed);
  }
  return rows;
}

export default function BulkImportModal({ connectionId, onClose, onImported }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedRow[]>([]);
  const [rawText, setRawText] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ updated: number; skipped: number } | null>(null);
  const [error, setError] = useState('');

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      setRawText(text);
      setParsed(parseCSV(text));
      setResult(null);
      setError('');
    };
    reader.readAsText(file);
  }

  function handlePasteChange(text: string) {
    setRawText(text);
    if (text.trim()) {
      setParsed(parseCSV(text));
    } else {
      setParsed([]);
    }
    setResult(null);
    setError('');
  }

  async function doImport() {
    if (!parsed.length) return;
    setImporting(true);
    setError('');
    try {
      const res = await api.post('/semantic/import', { connectionId, definitions: parsed });
      setResult(res.data.data);
      onImported();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed');
    }
    setImporting(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">Bulk Import Definitions</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <p className="text-sm text-slate-500">
            Upload a CSV file or paste CSV data below. Required column: <code className="bg-slate-100 px-1 rounded">table_name</code>.
            Optional: <code className="bg-slate-100 px-1 rounded">column_name</code>,{' '}
            <code className="bg-slate-100 px-1 rounded">display_name</code>,{' '}
            <code className="bg-slate-100 px-1 rounded">description</code>,{' '}
            <code className="bg-slate-100 px-1 rounded">is_dimension</code>,{' '}
            <code className="bg-slate-100 px-1 rounded">is_measure</code>,{' '}
            <code className="bg-slate-100 px-1 rounded">domains</code> (semicolon-separated),{' '}
            <code className="bg-slate-100 px-1 rounded">grain</code>.
          </p>

          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt"
              onChange={handleFile}
              className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-600 hover:file:bg-blue-100"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Or paste CSV data:</label>
            <textarea
              value={rawText}
              onChange={(e) => handlePasteChange(e.target.value)}
              rows={6}
              placeholder={`table_name,column_name,display_name,description\norders,,Sales Orders,All customer orders\norders,order_date,Order Date,Date the order was placed`}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          {parsed.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-slate-600 mb-2">
                Preview: {parsed.length} row{parsed.length !== 1 ? 's' : ''} parsed
              </h4>
              <div className="overflow-x-auto rounded-lg border border-slate-200 max-h-48">
                <table className="text-xs w-full">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="px-2 py-1.5 text-left font-medium text-slate-500">Table</th>
                      <th className="px-2 py-1.5 text-left font-medium text-slate-500">Column</th>
                      <th className="px-2 py-1.5 text-left font-medium text-slate-500">Display Name</th>
                      <th className="px-2 py-1.5 text-left font-medium text-slate-500">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.slice(0, 20).map((row, i) => (
                      <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                        <td className="px-2 py-1 font-mono text-slate-700">{row.table_name}</td>
                        <td className="px-2 py-1 font-mono text-slate-500">{row.column_name || '-'}</td>
                        <td className="px-2 py-1 text-slate-700">{row.display_name || '-'}</td>
                        <td className="px-2 py-1 text-slate-500 max-w-[200px] truncate">{row.description || '-'}</td>
                      </tr>
                    ))}
                    {parsed.length > 20 && (
                      <tr><td colSpan={4} className="px-2 py-1 text-center text-slate-400">...and {parsed.length - 20} more</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result && (
            <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700">
              Import complete: <strong>{result.updated}</strong> updated, <strong>{result.skipped}</strong> skipped (table/column not found).
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-600">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-200">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancel</button>
          <button
            onClick={doImport}
            disabled={!parsed.length || importing}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {importing ? 'Importing...' : `Import ${parsed.length} definition${parsed.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
