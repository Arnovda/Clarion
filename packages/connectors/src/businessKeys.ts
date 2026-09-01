/**
 * Business keys, declared by the source rather than guessed from the data.
 *
 * A business key is the column that IDENTIFIES a row — the thing you would
 * quote to a colleague to point at one record. It is not "whichever column
 * happens to hold unique values": on an append-only table a `Created`
 * timestamp is unique too, and picking it produces completeness and
 * uniqueness scores that read 100% while measuring nothing.
 *
 * For an API-style source the answer needs no inference at all — it is a fact
 * about the API surface, already declared on `EntityDescriptor.businessKey`
 * and already used by the warehouse writer to merge rows on re-sync. This
 * module exposes that same declaration to the profiler, so the platform stops
 * re-deriving something the connector has known all along.
 *
 * Same rung as `getKnownRelationships` on the SOURCE_ONBOARDING ladder
 * (`declared > curated > ai`) and, deliberately, the same shape: SYNCHRONOUS
 * and network-free. It is a compile-time constant, so a live-metadata failure
 * must never be able to cost us it.
 */
import type { EntityDescriptor } from './types';

export interface EntityBusinessKey {
  /** Entity name — matches `EntityDescriptor.name`, i.e. the warehouse table. */
  entity: string;
  /** The identifying column on that entity. */
  column: string;
}

/**
 * Project the `businessKey` declarations out of a connector's entity catalog,
 * filtered to the entities the tenant actually selected.
 *
 * Entities that declare no key are simply absent: the platform must be able
 * to tell "this source says the key is X" apart from "this source does not
 * say", and an entry with an empty column would erase that difference.
 */
export function businessKeysFromCatalog(
  catalog: readonly EntityDescriptor[],
  selectedEntities: readonly string[],
): EntityBusinessKey[] {
  const selected = new Set(selectedEntities.map((e) => e.toLowerCase()));
  const out: EntityBusinessKey[] = [];
  for (const entity of catalog) {
    const column = entity.businessKey?.trim();
    if (!column) continue;
    if (selected.size > 0 && !selected.has(entity.name.toLowerCase())) continue;
    out.push({ entity: entity.name, column });
  }
  return out;
}
