/**
 * scopedRequestDb.ts — a Knex handle whose EVERY query runs in its own short
 * transaction with `SET LOCAL app.current_tenant` (assessment 11-1).
 *
 * requireAuth opens one transaction per request and holds it until the
 * response ends. For an ordinary request that is the right tool: a few
 * queries, a few milliseconds, one connection. For a STREAM it is a
 * connection pinned `idle in transaction` for the stream's whole life —
 * a 90-second Ask AI answer, a 10-minute build — on a 1-vCore server with a
 * pool of six. Ten open streams on a replica and the eleventh request waits
 * for the acquire timeout and 500s.
 *
 * So the moment a response starts streaming (headers flushed — only
 * streaming does that before `end`), requireAuth COMMITS the request
 * transaction, gives the connection back, and swaps `req.dbTrx` for this:
 * the same call shape (`db('table').where(…)`, `db.raw(…)`,
 * `db.transaction(…)`, `db.fn.now()`), so the thirty-odd `reqDb(req)` sites
 * in the streaming routes keep working unchanged, but each query borrows a
 * connection only for its own duration — exactly `tenantQuery`, one call
 * at a time.
 *
 * Knex query builders are lazy: nothing hits the database until `.then()`
 * (or `await`, `.catch()`, `.finally()`, all of which go through `then`).
 * That is where this hooks in — the builder is built against the root
 * pool as usual and, when awaited, executed inside `tenantQuery` with
 * `.transacting(trx)`.
 */

import type { Knex } from 'knex';
import { semanticDb } from './knex';
import { tenantQuery } from '../services/tenantQuery';

type ThenFn = (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => Promise<unknown>;

function scopeBuilder(tenantId: number, qb: Knex.QueryBuilder): Knex.QueryBuilder {
  // Instance override — Knex defines `then` on the PROTOTYPE (the builder
  // interface augmenter), and `.catch()` / `.finally()` call `this.then()`.
  // The prototype's `then` is what actually executes; the override must
  // call THAT, not `await qb` (which would re-enter the override forever
  // and drain the pool — measured on the first run of this file's test).
  const nativeThen = Object.getPrototypeOf(qb).then as ThenFn;
  const scopedThen: ThenFn = (onFulfilled, onRejected) =>
    tenantQuery(tenantId, (trx) => nativeThen.call(qb.transacting(trx as Knex.Transaction)))
      .then(onFulfilled, onRejected);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (qb as any).then = scopedThen;
  return qb;
}

/**
 * A tenant-scoped, per-query Knex handle. Typed as `Knex` because that is
 * how every `reqDb(req)` consumer already types it.
 */
export function scopedRequestDb(tenantId: number): Knex {
  const call = (tableName?: Knex.TableDescriptor | Knex.AliasDict) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scopeBuilder(tenantId, tableName === undefined ? semanticDb.queryBuilder() : semanticDb(tableName as any));

  return new Proxy(call as unknown as Knex, {
    apply(_target, _thisArg, args: unknown[]) {
      return (call as (...a: unknown[]) => unknown)(...args);
    },
    get(_target, prop) {
      switch (prop) {
        case 'raw':
          return (...args: Parameters<Knex['raw']>) =>
            tenantQuery(tenantId, (trx) => Promise.resolve(trx.raw(...args)));
        case 'transaction':
          return (fn?: (trx: Knex.Transaction) => Promise<unknown>) =>
            tenantQuery(tenantId, (trx) => (fn ? fn(trx as Knex.Transaction) : Promise.resolve(trx)));
        case 'queryBuilder':
          return () => scopeBuilder(tenantId, semanticDb.queryBuilder());
        case 'isTransaction':
          return false;
        case 'scopedTenantId':
          return tenantId;
        default:
          return (semanticDb as unknown as Record<PropertyKey, unknown>)[prop];
      }
    },
  });
}
