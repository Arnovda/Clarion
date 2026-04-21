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
        <div key={`t${i}`} className="overflow-x-auto mt-2 mb-1 rounded-md border border-line">
          <table className="text-[12px] w-full border-collapse">
            <thead>
              <tr>
                {headers.map((h, j) => (
                  <th
                    key={j}
                    className={`px-3 py-2 font-mono font-medium text-[10px] uppercase tracking-[0.08em]
                      bg-softer
                      border-b border-line
                      text-muted whitespace-nowrap
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
                  className="border-b border-line last:border-b-0"
                >
                  {row.map((cell, k) => (
                    <td
                      key={k}
                      className={`px-3 py-1.5 whitespace-nowrap text-ink-2
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

  return <div className="text-[13px] leading-relaxed">{elements}</div>;
}
