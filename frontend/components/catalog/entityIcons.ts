/**
 * entityIcons — keyword → Lucide glyph for catalog datasets.
 *
 * Why: the source-colour palette (sourcePalette.ts) deliberately tints every
 * dataset from one source the SAME colour (ExactOnline = emerald everywhere)
 * for cross-app continuity. That continuity is good, but it means Finance /
 * Sales / Purchases / Date / Item all look identical at a glance. A
 * business owner thinks in subjects — a calendar IS "Date", a cart IS
 * "Purchases" — so we differentiate by GLYPH instead of by colour. Variety
 * without breaking the colour contract.
 *
 * Matching is a simple case-insensitive substring scan over an ordered rule
 * list (first hit wins), so "GL Account" resolves before the looser "account"
 * rule. Always falls back to a sensible default — never throws, never blank.
 */

import {
  Landmark, ShoppingCart, Receipt, Users, Boxes, FolderKanban, Megaphone,
  Banknote, TrendingUp, Factory, Truck, BarChart3,
  Calendar, CalendarRange, Package, BookText, Warehouse, CreditCard,
  Coins, Percent, MapPin, Tags, Building2, UserRound, Tag,
  type LucideIcon,
} from 'lucide-react';

type Rule = [test: RegExp, icon: LucideIcon];

/** Ordered — more specific patterns first. */
const ANALYTICS_RULES: Rule[] = [
  [/purchas|supplier|vendor|payable|procure|\bap\b/, ShoppingCart],
  [/sales|revenue|invoic|receivable|\bar\b|order|quotation/, Receipt],
  [/financ|ledger|\bgl\b|account|book|fiscal|budget/, Landmark],
  [/\bhr\b|employee|people|payroll|staff|headcount/, Users],
  [/inventor|stock|warehouse|item|\bsku\b|article/, Boxes],
  [/manufactur|production|\bbom\b|assembly/, Factory],
  [/logistic|shipment|deliver|freight|fulfil/, Truck],
  [/project|task|milestone/, FolderKanban],
  [/marketing|campaign|lead|funnel/, Megaphone],
  [/cash|bank|payment|treasury/, Banknote],
  [/growth|trend|forecast|kpi|metric/, TrendingUp],
];

/** Ordered — more specific patterns first. */
const REFERENCE_RULES: Rule[] = [
  [/\bgl\b|chart of account|ledger account/, Landmark],
  [/financial period|fiscal|\bperiod\b|quarter|\byear\b/, CalendarRange],
  [/date|calendar|\btime\b|\bday\b|month/, Calendar],
  [/payment|terms|condition|due/, CreditCard],
  [/warehouse|location|store|site|depot/, Warehouse],
  [/journal|book|entry/, BookText],
  [/item|product|article|\bsku\b|material/, Package],
  [/account|customer|supplier|vendor|party|contact|debtor|creditor/, Users],
  [/employee|\buser\b|person|staff/, UserRound],
  [/currenc|\bfx\b|exchange/, Coins],
  [/\btax\b|\bvat\b|duty/, Percent],
  [/region|countr|geo|address|territory/, MapPin],
  [/compan|organi|entit|division|department|cost cent/, Building2],
  [/categor|group|class|segment|type/, Tags],
];

function resolve(rules: Rule[], name: string | null | undefined, fallback: LucideIcon): LucideIcon {
  if (!name) return fallback;
  const hay = name.toLowerCase();
  for (const [test, icon] of rules) {
    if (test.test(hay)) return icon;
  }
  return fallback;
}

/** Glyph for an analytics product (a "what you can analyse" subject). */
export function iconForAnalytics(name: string | null | undefined): LucideIcon {
  return resolve(ANALYTICS_RULES, name, BarChart3);
}

/** Glyph for a reference dataset (a "what you can analyse it by" lens). */
export function iconForReference(name: string | null | undefined): LucideIcon {
  return resolve(REFERENCE_RULES, name, Tag);
}
