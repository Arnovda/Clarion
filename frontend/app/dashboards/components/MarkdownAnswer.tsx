'use client';

import type { ReactNode } from 'react';

function renderInline(text: string): ReactNode {
  const parts = text.split(/\*\*(.*?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : part,
  );
}

export function MarkdownAnswer({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Table: header row followed by separator row (|---|)
    if (
      line.trim().startsWith('|') &&
      lines[i + 1]?.trim().startsWith('|---')
    ) {
      const headers = line
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(
          lines[i]
            .split('|')
            .map((c) => c.trim())
            .filter(Boolean),
        );
        i++;
      }

      // Detect numeric columns by checking if most values are numeric
      const isNumCol = headers.map((_, ci) => {
        const numCount = rows.filter((row) => {
          const v = row[ci]?.replace(/[€$,%\s]/g, '');
          return v && !isNaN(Number(v));
        }).length;
        return numCount > rows.length / 2;
      });

      elements.push(
        <div key={`t${i}`} className="overflow-x-auto mt-2 mb-1 rounded-lg">
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr>
                {headers.map((h, j) => (
                  <th
                    key={j}
                    className={`px-3 py-2 font-semibold
                      bg-slate-50/80
                      border-b border-slate-200/60
                      text-slate-600 whitespace-nowrap
                      ${isNumCol[j] ? 'text-right' : 'text-left'}`}
                  >
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, j) => (
                <tr
                  key={j}
                  className={`border-b border-slate-100/40
                    ${j % 2 === 0
                      ? 'bg-white'
                      : 'bg-slate-50/40'
                    }`}
                >
                  {row.map((cell, k) => (
                    <td
                      key={k}
                      className={`px-3 py-1.5 whitespace-nowrap text-slate-700
                        ${isNumCol[k] ? 'text-right font-mono tabular-nums' : ''}`}
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (line.trim()) {
      elements.push(
        <p key={`p${i}`} className="mb-1">
          {renderInline(line)}
        </p>,
      );
      i++;
    } else {
      i++;
    }
  }

  return <div className="text-sm leading-relaxed">{elements}</div>;
}
