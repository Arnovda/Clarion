/**
 * The one ingestion loop.
 *
 * Every connector's `sync()` does the same job in the same order: resolve the
 * selected entities, walk them one at a time, stop cleanly when the run's time
 * budget runs out, write rows through the warehouse writer, advance the cursor
 * only when it genuinely moved, and keep going when a single entity fails. Only
 * the middle step — *how you get rows out of this particular source* — is
 * source-specific.
 *
 * Before this module that loop existed twice, in `ExactOnlineConnector` and
 * `OdooConnector`, as ~90 lines of near-identical code each. Two copies is a
 * style problem; at the 200 connectors this framework is meant to host it is a
 * correctness problem, because every rule the platform has learned the hard way
 * — the empty-batch refusal, per-entity isolation, never swallowing
 * cancellation, advancing a cursor only on a strictly-greater value — has to be
 * re-implemented correctly by each new connector author, and a connector that
 * gets one subtly wrong looks exactly like one that got it right.
 *
 * So the rule this module exists to enforce: **a connector describes its
 * source; it does not re-implement ingestion.** Where connectors genuinely
 * differ, the difference is DECLARED (see `canCheckpoint`) rather than written
 * out as a second code path, so it can be read, tested, and reasoned about
 * instead of diffed.
 *
 * What a connector still owns:
 *   • its entity catalog (static for a documented API, introspected for a
 *     database the customer owns)
 *   • `pull()` — fetch this entity's rows and hand them to the writer,
 *     normally via `BaseSourceConnector.writeEntityInChunks`
 *   • `listKeys()` — the cheap key-only listing a reconcile runs on
 *
 * Everything else below is the platform's, once.
 */

import {
  CancellationError,
  type EntityCursor,
  type EntityCursorSpec,
  type SyncContext,
  type SyncOptions,
  type SyncResult,
} from './types';

/**
 * The slice of an entity descriptor the engine needs. Connectors pass their
 * own richer type (`ExactOnlineEntity`, `OdooEntity`, `SqlEntity`, …) and the
 * generic parameter carries it through to the hooks unchanged.
 */
export interface SyncEntity {
  name: string;
  displayName?: string;
  businessKey?: string;
  readonly incrementalCursor?: EntityCursorSpec;
}

/** What `pull()` reports back. Mirrors `ChunkedWriteResult` one-for-one. */
export interface EntityPullResult {
  rowsWritten: number;
  bytesWritten: number;
  /** Rows the table HOLDS after the write, soft-deleted rows excluded. */
  rowsTotal?: number;
  /** Highest cursor value observed in the rows written this run. */
  maxCursorSeen?: string;
  /** The source returned nothing and the writer kept the previous table. */
  preservedExisting?: boolean;
  /** The run's time budget ended the entity before its rows ran out. */
  stoppedForBudget: boolean;
  /**
   * User-facing warnings this entity produced (a full re-sync's tombstone
   * count, a degraded schema fallback). RETURNED rather than pushed into a
   * shared array: a hook that mutates its caller's state is the kind of
   * coupling that silently loses messages the moment the caller changes how
   * it collects them.
   */
  warnings?: string[];
}

/**
 * The source-specific half of a sync. Implemented once per connector.
 */
export interface EntitySyncSource<E extends SyncEntity> {
  /** Extra structured fields for the per-entity log line (`apiPath`, `model`, `schema`…). */
  logFields?(entity: E): Record<string, unknown>;

  /**
   * May a partial pull of this entity leave a valid RESUME POINT?
   *
   * This is the one place the connectors genuinely disagree, and it is a fact
   * about the source's paging, not a preference:
   *
   *   • A source paged by KEY in ascending cursor order (Exact Online's
   *     `Modified asc`, a keyset-paginated SQL query) can checkpoint. Rows
   *     arrive in cursor order, so "everything up to X is written" is true,
   *     and a row updated mid-run moves FORWARD in the ordering — it is seen
   *     again, never skipped.
   *
   *   • A source paged by OFFSET (Odoo's `search_read` with `offset`) cannot.
   *     A row updated during the pull can shift the page window and hide
   *     another row behind a boundary, so the highest cursor seen is not a
   *     safe watermark. Such an entity is re-pulled from its prior cursor next
   *     run; the merge-by-key writer makes that idempotent, so the cost is
   *     time, never rows.
   *
   * Declaring it wrong in the permissive direction SKIPS ROWS SILENTLY, which
   * is why it is a required method with no default.
   */
  canCheckpoint(entity: E): boolean;

  /** Fetch this entity's rows and write them. The connector's real work. */
  pull(args: {
    entity: E;
    ctx: SyncContext;
    /** Absent on a first sync, and on a full re-sync (which ignores cursors). */
    priorCursor?: EntityCursor;
    fullResync: boolean;
  }): Promise<EntityPullResult>;

  /**
   * The keys the source holds TODAY, for `opts.reconcile`. Key-only listings
   * are a fraction of a full pull on every source we have met (`$select=ID`,
   * `fields: ['id']`, `SELECT id FROM t`), which is what makes delete
   * detection affordable enough to schedule. Omit when the source cannot list
   * keys without also returning rows — the engine then says so rather than
   * pretending to reconcile.
   */
  listKeys?(args: { entity: E; ctx: SyncContext }): AsyncIterable<string | number>;
}

/**
 * Resolve selected entity names against a connector's catalog.
 *
 * Separate from `runEntitySync` because several connectors need the resolved
 * list BEFORE the loop starts (Exact Online fetches OData `$metadata` once for
 * the whole run). Shared so the two user-facing warnings below read the same
 * whichever source produced them.
 */
export function resolveSyncEntities<E extends SyncEntity>(
  names: readonly string[],
  resolve: (name: string) => E | undefined,
): { entities: E[]; warnings: string[] } {
  const entities: E[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    const entity = resolve(name);
    if (!entity) {
      warnings.push(`Unknown entity '${name}' — skipped.`);
      continue;
    }
    entities.push(entity);
  }
  return { entities, warnings };
}

/**
 * Run a sync over already-resolved entities.
 *
 * `seedWarnings` carries anything the connector accumulated during setup (an
 * unknown entity name, a metadata fetch that degraded) so the caller never has
 * to merge two warning lists by hand.
 */
export async function runEntitySync<E extends SyncEntity>(args: {
  source: EntitySyncSource<E>;
  entities: readonly E[];
  opts: SyncOptions;
  ctx: SyncContext;
  seedWarnings?: readonly string[];
}): Promise<SyncResult> {
  const { source, entities, opts, ctx } = args;
  const warnings: string[] = [...(args.seedWarnings ?? [])];

  // RECONCILE (phase 2, B2): keys only, no row content, no cursor movement.
  if (opts.reconcile) {
    return runReconcile({ source, entities, ctx, seedWarnings: warnings });
  }

  const rowCounts: Record<string, number> = {};
  const cursors: Record<string, EntityCursor> = {};
  const failedEntities: Record<string, string> = {};
  const incompleteEntities: NonNullable<SyncResult['incompleteEntities']> = {};

  // A full re-sync ignores every prior cursor, MERGES every row it pulls, and
  // then marks what it did not see as deleted (phase 2, B2). That is the only
  // path that removes rows deleted at the source.
  const fullResync = opts.fullResync === true;

  for (const entity of entities) {
    // Cancellation is the one thing that ends the whole run. Checked between
    // entities as well as inside each pull.
    ctx.cancellationToken.throwIfCancelled();

    // Out of time before this entity even started. Not a failure — it is the
    // next run's work, and the orchestrator queues a continuation for it.
    if (ctx.timeBudget?.shouldStop()) {
      incompleteEntities[entity.name] = { reason: 'time_budget', rowsSoFar: 0 };
      continue;
    }

    const label = entity.displayName ?? entity.name;
    ctx.progress({ message: `Syncing ${label}…` });

    const priorCursor = fullResync ? undefined : opts.cursors?.[entity.name];
    ctx.log.info(`syncing ${entity.name}`, {
      ...(source.logFields?.(entity) ?? {}),
      mode: fullResync
        ? 'full-resync'
        : entity.incrementalCursor
          ? priorCursor
            ? 'incremental'
            : 'initial-full'
          : 'always-full',
      priorCursor: priorCursor?.value,
    });

    try {
      const pulled = await source.pull({ entity, ctx, priorCursor, fullResync });
      const { rowsWritten, bytesWritten, rowsTotal, maxCursorSeen, preservedExisting, stoppedForBudget } = pulled;
      rowCounts[entity.name] = rowsWritten;
      if (pulled.warnings?.length) warnings.push(...pulled.warnings);

      // An empty response over an existing table PRESERVES it (P0-6): a
      // throttled endpoint and a genuinely emptied table look identical from
      // here, and only one of those should cost the customer their rows.
      if (preservedExisting) {
        warnings.push(
          `Entity '${entity.name}' returned no rows; the previous table was kept. ` +
          `Run a full re-sync if the source really is empty now.`,
        );
      } else if (rowsWritten === 0 && !stoppedForBudget) {
        warnings.push(`Entity '${entity.name}' returned no rows.`);
      }

      // THE CURSOR ADVANCE RULE. Connectors FILTER with `>=` so a
      // second-precision watermark cannot skip a boundary row (the re-pull is
      // idempotent under merge-by-key), but the cursor only ADVANCES on a
      // strictly-greater value — otherwise the same window is re-pulled
      // forever, and the orchestrator's monotonicity guard rejects it anyway.
      let newCursor: EntityCursor | undefined;
      if (entity.incrementalCursor && maxCursorSeen) {
        if (!priorCursor || maxCursorSeen > priorCursor.value) {
          newCursor = { type: entity.incrementalCursor.type, value: maxCursorSeen };
        }
      }

      if (stoppedForBudget) {
        // Rows up to the checkpoint are durably written. The entity is not
        // finished, so it must NOT also count as completed. Whether the
        // checkpoint is a valid resume point is the source's declaration.
        const checkpoint = source.canCheckpoint(entity) ? newCursor : undefined;
        incompleteEntities[entity.name] = {
          reason: 'time_budget',
          rowsSoFar: rowsWritten,
          ...(checkpoint ? { cursor: checkpoint } : {}),
        };
        ctx.log.warn(
          checkpoint
            ? `entity '${entity.name}' stopped at the time budget — resumes next run`
            : `entity '${entity.name}' stopped at the time budget — re-pulled next run`,
          { rowsSoFar: rowsWritten, checkpoint: checkpoint?.value },
        );
        continue;
      }

      if (newCursor) cursors[entity.name] = newCursor;
      await ctx.onEntityComplete?.({
        entity: entity.name,
        rowsWritten,
        bytesWritten,
        ...(rowsTotal !== undefined ? { rowsTotal } : {}),
        ...(newCursor ? { cursor: newCursor } : {}),
      });
    } catch (err) {
      // Never swallow cancellation — it means a human asked this to stop.
      if (err instanceof CancellationError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // Per-entity isolation: one bad endpoint must not lose the other
      // nineteen. The run is persisted as `partial`, which is visible and
      // alertable — unlike the pre-P0-6 behaviour, where it was a warning on
      // a run marked `succeeded`.
      ctx.log.warn(`entity '${entity.name}' failed — continuing with remaining entities`, { error: msg });
      warnings.push(`Entity '${entity.name}' failed: ${msg}`);
      failedEntities[entity.name] = msg;
      rowCounts[entity.name] = 0;
      // No cursor for a failed entity: the next run resumes from the same point.
    }
  }

  return {
    rowCounts,
    warnings,
    cursors,
    failedEntities,
    ...(Object.keys(incompleteEntities).length > 0 ? { incompleteEntities } : {}),
  };
}

/**
 * RECONCILE (phase 2, B2) — delete detection without a full re-sync.
 *
 * For every entity with a business key, list the keys the source holds today
 * and let the writer mark rows whose key is gone as deleted, reviving any that
 * came back. Row CONTENT is never touched and cursors never move: a reconcile
 * says nothing about what changed inside a row, only about which rows exist.
 */
async function runReconcile<E extends SyncEntity>(args: {
  source: EntitySyncSource<E>;
  entities: readonly E[];
  ctx: SyncContext;
  seedWarnings: string[];
}): Promise<SyncResult> {
  const { source, entities, ctx } = args;
  const warnings = [...args.seedWarnings];
  const rowCounts: Record<string, number> = {};
  const failedEntities: Record<string, string> = {};
  const writer = ctx.warehouseWriter;

  if (!writer.reconcileKeys) {
    return { rowCounts, warnings: [...warnings, 'This warehouse writer cannot reconcile keys.'], failedEntities };
  }
  if (!source.listKeys) {
    return {
      rowCounts,
      warnings: [...warnings, 'This source cannot list keys without pulling rows — run a full re-sync instead.'],
      failedEntities,
    };
  }

  for (const entity of entities) {
    ctx.cancellationToken.throwIfCancelled();
    const key = entity.businessKey;
    if (!key) {
      warnings.push(`Entity '${entity.name}' declares no business key — nothing to reconcile on.`);
      continue;
    }
    ctx.progress({ message: `Reconciling ${entity.displayName ?? entity.name}…` });
    try {
      const keys = source.listKeys({ entity, ctx });
      const r = await writer.reconcileKeys(entity.name, key, keys);
      rowCounts[entity.name] = r.rowsTotal;
      if (r.refusedEmpty) {
        // THE EMPTY-BATCH RULE, again: an empty key list over a non-empty
        // table is refused, because a throttled endpoint looks exactly like
        // an emptied table and only one of those should tombstone everything.
        warnings.push(
          `Entity '${entity.name}': the source listed no keys, so nothing was marked deleted ` +
          `(a throttled endpoint looks the same as an empty table).`,
        );
      } else if (r.tombstoned > 0 || r.revived > 0) {
        warnings.push(
          `Entity '${entity.name}': ${r.tombstoned} row(s) no longer at the source were hidden` +
          (r.revived > 0 ? `, ${r.revived} came back` : '') + '.',
        );
      }
      ctx.log.info(`${entity.name} reconciled`, { ...r });
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.warn(`entity '${entity.name}' reconcile failed — continuing`, { error: msg });
      warnings.push(`Entity '${entity.name}' reconcile failed: ${msg}`);
      failedEntities[entity.name] = msg;
    }
  }

  return { rowCounts, warnings, failedEntities, cursors: {} };
}
