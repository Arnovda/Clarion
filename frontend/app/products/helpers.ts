/**
 * Pure helpers for /products — no React, no state.
 */

export function statusBorderColor(status: string): string {
  switch (status) {
    case 'approved':
    case 'success':
      return 'border-l-ok';
    case 'error':
      return 'border-l-err';
    case 'designing':
    case 'running':
      return 'border-l-ocean';
    default:
      return 'border-l-line-strong';
  }
}

/** Pick an emoji icon based on a data-product name's keywords. */
export function productIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('sales') || n.includes('revenue') || n.includes('order')) return '\u{1F4B0}';
  if (n.includes('customer') || n.includes('client') || n.includes('crm')) return '\u{1F465}';
  if (n.includes('product') || n.includes('article') || n.includes('item') || n.includes('catalogue')) return '\u{1F4E6}';
  if (n.includes('supplier') || n.includes('vendor') || n.includes('purchas')) return '\u{1F3ED}';
  if (n.includes('hr') || n.includes('employee') || n.includes('staff') || n.includes('payroll') || n.includes('people')) return '\u{1F9D1}\u{200D}\u{1F4BC}';
  if (n.includes('finance') || n.includes('accounting') || n.includes('budget') || n.includes('cost')) return '\u{1F4CA}';
  if (n.includes('inventory') || n.includes('stock') || n.includes('warehouse') || n.includes('logistic')) return '\u{1F3EA}';
  if (n.includes('market') || n.includes('campaign') || n.includes('lead')) return '\u{1F4E3}';
  if (n.includes('delivery') || n.includes('ship') || n.includes('transport')) return '\u{1F69A}';
  if (n.includes('project') || n.includes('task') || n.includes('time') || n.includes('hour')) return '\u{1F4CB}';
  return '\u{1F4C8}';
}

/** Strip common "Analytics / 360 / Domain / Product / Data Product / Kimball" suffixes. */
export function cleanTopicName(name: string): string {
  return name
    .replace(/\s+(Analytics|360|Domain|Product|Data Product|Kimball)$/i, '')
    .trim();
}
