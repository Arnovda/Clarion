/**
 * Pure helpers extracted from page.tsx — no React, no hooks, no state.
 */

/** Format raw SQL by breaking common keywords onto new lines with a 2-space indent. */
export function formatSql(raw: string): string {
  let sql = raw.replace(/\s+/g, ' ').trim();
  const breaks = [
    'SELECT', 'FROM',
    'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
    'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'JOIN',
    'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
    'UNION ALL', 'UNION', 'EXCEPT', 'INTERSECT',
  ];
  for (const kw of breaks) {
    sql = sql.replace(new RegExp(`\\b(${kw})\\b`, 'gi'), `\n$1`);
  }
  return sql.split('\n').map((l, i) => (i === 0 ? l : '  ' + l.trim())).join('\n').trim();
}

/**
 * Format a query-result cell value.
 * Numbers get `nl-BE` grouping; monetary-looking decimals get a euro prefix.
 */
export function formatCellValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)))) {
    const n = Number(v);
    if (Math.abs(n) >= 10 && String(v).includes('.'))
      return `\u20AC${n.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return n.toLocaleString('nl-BE', { maximumFractionDigits: 2 });
  }
  return String(v);
}
