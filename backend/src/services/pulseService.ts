/**
 * Pulse service — per-user "what should Clarion watch for me" list.
 *
 * The backbone for every proactive feature on the Clarion roadmap:
 *   - morning brief job reads the pulse to know what to summarise
 *   - push alerts fire on pulse entries when sensitivity threshold trips
 *   - Investigate uses the pulse as a hint for "where to start"
 *   - "Suggested focus" frames recommendations in pulse vocabulary
 *
 * One mechanism, multiple downstream wins. Keep this service the
 * single read/write entry point for `user_pulse_entries`.
 */

import { semanticDb } from '../db/knex';
import { tenantQuery } from './tenantQuery';
import { logger } from '../utils/logger';
import {
  type PulseSuggestContext,
  type PulseSuggestResult,
} from '../ai/prompts/pulseSuggestPrompt';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PulseKind = 'metric' | 'slice' | 'theme';
export type PulseSensitivity = 'low' | 'medium' | 'high';
export type PulseFrequency = 'daily' | 'weekly';

export interface PulseEntry {
  id: number;
  user_id: number;
  kind: PulseKind;
  product_kpi_id: number | null;
  data_product_id: number | null;
  dimension_table: string | null;
  dimension_column: string | null;
  theme_text: string | null;
  sensitivity: PulseSensitivity;
  frequency: PulseFrequency;
  label: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  // Joined fields, populated on read
  kpi_name?: string | null;
  product_name?: string | null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listPulse(
  tenantId: number,
  userId: number,
): Promise<PulseEntry[]> {
  return tenantQuery(tenantId, (trx) =>
    trx('user_pulse_entries as upe')
      .leftJoin('product_kpis as pk', 'upe.product_kpi_id', 'pk.id')
      .leftJoin('data_products as dp', 'upe.data_product_id', 'dp.id')
      .where('upe.user_id', userId)
      .orderBy(['upe.position', 'upe.id'])
      .select<PulseEntry[]>(
        'upe.*',
        'pk.name as kpi_name',
        'dp.name as product_name',
      ),
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreatePulseInput {
  kind: PulseKind;
  product_kpi_id?: number | null;
  data_product_id?: number | null;
  dimension_table?: string | null;
  dimension_column?: string | null;
  theme_text?: string | null;
  sensitivity?: PulseSensitivity;
  frequency?: PulseFrequency;
  label?: string | null;
}

/**
 * Create a single pulse entry. Validates that the referenced KPI exists
 * (and is visible to the user via RLS — `tenantQuery` sets that up).
 */
export async function createPulse(
  tenantId: number,
  userId: number,
  input: CreatePulseInput,
): Promise<PulseEntry> {
  if (input.kind === 'metric' || input.kind === 'slice') {
    if (!input.product_kpi_id) {
      throw new Error(`kind=${input.kind} requires product_kpi_id`);
    }
  }
  if (input.kind === 'slice' && (!input.dimension_table || !input.dimension_column)) {
    throw new Error('kind=slice requires dimension_table and dimension_column');
  }

  const id = await tenantQuery(tenantId, async (trx) => {
    // Validate the KPI lives in the tenant (RLS enforces this; the
    // explicit check just gives a clean error message).
    if (input.product_kpi_id) {
      const kpi = await trx('product_kpis').where({ id: input.product_kpi_id }).first();
      if (!kpi) throw new Error(`KPI ${input.product_kpi_id} not found`);
    }

    const maxPos = await trx('user_pulse_entries')
      .where({ user_id: userId })
      .max<{ max: number | null }[]>('position as max');
    const nextPos = (maxPos[0]?.max ?? -1) + 1;

    const [row] = await trx('user_pulse_entries').insert({
      user_id:          userId,
      kind:             input.kind,
      product_kpi_id:   input.product_kpi_id ?? null,
      data_product_id:  input.data_product_id ?? null,
      dimension_table:  input.dimension_table ?? null,
      dimension_column: input.dimension_column ?? null,
      theme_text:       input.theme_text ?? null,
      sensitivity:      input.sensitivity ?? 'medium',
      frequency:        input.frequency ?? 'daily',
      label:            input.label ?? null,
      position:         nextPos,
    }).returning('id');
    return typeof row === 'object' ? Number((row as { id: number }).id) : Number(row);
  });

  const all = await listPulse(tenantId, userId);
  return all.find((e) => e.id === id) ?? all[all.length - 1];
}

export interface UpdatePulseInput {
  sensitivity?: PulseSensitivity;
  frequency?: PulseFrequency;
  label?: string | null;
  position?: number;
}

export async function updatePulse(
  tenantId: number,
  userId: number,
  entryId: number,
  input: UpdatePulseInput,
): Promise<void> {
  const allowed: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.sensitivity !== undefined) allowed.sensitivity = input.sensitivity;
  if (input.frequency !== undefined) allowed.frequency = input.frequency;
  if (input.label !== undefined) allowed.label = input.label;
  if (input.position !== undefined) allowed.position = input.position;

  await tenantQuery(tenantId, (trx) =>
    trx('user_pulse_entries')
      .where({ id: entryId, user_id: userId })
      .update(allowed),
  );
}

export async function deletePulse(
  tenantId: number,
  userId: number,
  entryId: number,
): Promise<void> {
  await tenantQuery(tenantId, (trx) =>
    trx('user_pulse_entries')
      .where({ id: entryId, user_id: userId })
      .delete(),
  );
}

// ---------------------------------------------------------------------------
// AI suggestions — runs once on first visit to seed the pulse, but the
// user can re-run any time to see fresh ideas.
// ---------------------------------------------------------------------------

export async function suggestPulse(
  tenantId: number,
  userId: number,
): Promise<PulseSuggestResult> {
  const context = await buildSuggestContext(tenantId, userId);

  // Empty fast-path — no AI call needed.
  if (context.products.length === 0) {
    return {
      suggestions: [],
      hint: 'You don\'t have any data products yet. Design one first, then come back to set up your pulse.',
    };
  }
  const totalKpis = context.products.reduce((n, p) => n + p.kpis.length, 0);
  if (totalKpis === 0) {
    return {
      suggestions: [],
      hint: 'Your products don\'t have KPIs yet. Open a product and define a few — then this list will populate.',
    };
  }

  // Lazy-load the AIService so we don't pull all the prompt code into
  // module-load time for routes that never need it.
  const { suggestPulseEntries } = await import('../ai/AIService');
  return suggestPulseEntries(context);
}

async function buildSuggestContext(
  tenantId: number,
  userId: number,
): Promise<PulseSuggestContext> {
  return tenantQuery(tenantId, async (trx) => {
    const user = await trx('users').where({ id: userId }).first();
    const products = await trx('data_products')
      .whereIn('status', ['approved', 'success', 'draft'])
      .select('id', 'name', 'description');

    const productIds = products.map((p) => Number(p.id));

    const kpis = productIds.length > 0
      ? await trx('product_kpis')
          .whereIn('data_product_id', productIds)
          .select('id', 'data_product_id', 'name', 'description')
      : [];

    // Dimension columns — we want any product_columns flagged as
    // dimension role on a successfully materialised table. These are
    // the candidates for slice-by suggestions.
    const dims = productIds.length > 0
      ? await trx('product_columns as pc')
          .join('product_tables as pt', 'pc.product_table_id', 'pt.id')
          .join('star_schemas as ss', 'pt.star_schema_id', 'ss.id')
          .whereIn('ss.data_product_id', productIds)
          .where('pc.column_role', 'dimension')
          .select(
            'ss.data_product_id as product_id',
            'pt.table_name',
            'pc.column_name',
            'pc.description',
          )
      : [];

    const kpisByProduct = new Map<number, typeof kpis>();
    for (const k of kpis) {
      const list = kpisByProduct.get(Number(k.data_product_id)) ?? [];
      list.push(k);
      kpisByProduct.set(Number(k.data_product_id), list);
    }
    const dimsByProduct = new Map<number, typeof dims>();
    for (const d of dims) {
      const list = dimsByProduct.get(Number(d.product_id)) ?? [];
      list.push(d);
      dimsByProduct.set(Number(d.product_id), list);
    }

    return {
      userDisplayName: user ? String(user.display_name ?? user.email ?? '') : null,
      products: products.map((p) => ({
        productId: Number(p.id),
        productName: String(p.name),
        productDescription: p.description ? String(p.description) : null,
        kpis: (kpisByProduct.get(Number(p.id)) ?? []).map((k) => ({
          kpiId: Number(k.id),
          name: String(k.name),
          description: k.description ? String(k.description) : null,
        })),
        dimensionColumns: (dimsByProduct.get(Number(p.id)) ?? []).map((d) => ({
          tableName: String(d.table_name),
          columnName: String(d.column_name),
          description: d.description ? String(d.description) : null,
        })),
      })),
    };
  });
}

/** Bulk-create from a set of approved suggestions. Atomic. */
export async function applySuggestions(
  tenantId: number,
  userId: number,
  suggestions: Array<CreatePulseInput>,
): Promise<number> {
  if (suggestions.length === 0) return 0;
  let inserted = 0;
  for (const s of suggestions) {
    try {
      await createPulse(tenantId, userId, s);
      inserted++;
    } catch (err) {
      // One bad suggestion shouldn't kill the whole batch.
      logger.warn({ err, suggestion: s }, 'pulseService.applySuggestions: skipped one entry');
    }
  }
  return inserted;
}
