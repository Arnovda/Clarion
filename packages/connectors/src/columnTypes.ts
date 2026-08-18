/**
 * Whether two columns could be the two ends of the same key.
 *
 * **This exists because "the vendor documents this relationship" turned out to
 * be half a fact.** A source's docs typically hyperlink a foreign-key property
 * to the TARGET ENTITY's page — that much is verbatim. Which COLUMN of that
 * entity the key lands on is not stated on the row; a transcription has to
 * infer it, and the obvious inference (take the entity's primary key) is wrong
 * whenever the entity has a second, human-readable key.
 *
 * Measured on Exact Online's 245 documented references: **35 of them cross a
 * type boundary** — 32 `Edm.String → Edm.Guid` and 3 `Edm.Int32 → Edm.Guid`.
 * `TransactionLines.JournalCode` is `Edm.String` and holds a journal code;
 * it was pointed at `Journals.ID`, a GUID, because that is the key the vendor
 * marks. It measures 0% containment. `Journals.Code` — the same type, and what
 * Clarion's own catalogue says — measures 100%.
 *
 * A wrong foreign key presented under the source's authority is worse than a
 * missing one: it is exactly the shape of the invented-FK defect the 2026-08-03
 * audit was written to stop, only now wearing the vendor's name. So a
 * type-mismatched reference is REFUSED at the documented rung rather than
 * guessed at. It is not destroyed — it can still be found by the ordinary
 * value-overlap detector and land in *To review*, where the data decides and a
 * person confirms. That is the right place for a claim we cannot stand behind.
 *
 * **The check only fires when BOTH sides declare a type.** Connectors that
 * publish no type information (Odoo's `fields_get` docs channel, today) are
 * unaffected — an unrecognised or absent type is `unknown`, and `unknown` is
 * compatible with everything. This can only remove wrong claims, never
 * invent a rejection out of silence.
 */
export type TypeClass =
  | 'guid' | 'string' | 'number' | 'bool' | 'datetime' | 'binary' | 'unknown';

/**
 * Patterns are matched against the lower-cased declared type. Deliberately
 * broad across vendors — OData Edm names, SQL type names, and the plain words
 * connectors tend to use — because this module is the platform's rule, not
 * Exact Online's.
 *
 * GUID is its own class rather than a kind of string, and that distinction is
 * the entire point: a column of short codes and a column of GUIDs cannot be
 * two ends of one key, however alike they look once both land in the warehouse
 * as VARCHAR.
 */
const CLASSES: ReadonlyArray<readonly [RegExp, TypeClass]> = [
  [/^(edm\.)?guid$|^uuid$|^uniqueidentifier$/, 'guid'],
  [/^(edm\.)?boolean$|^bool$|^bit$/, 'bool'],
  [/^(edm\.)?(datetime|datetimeoffset|date|time)$|^timestamp/, 'datetime'],
  [/^(edm\.)?binary$|^bytea$|^blob$|^varbinary/, 'binary'],
  [
    /^(edm\.)?(byte|sbyte|int16|int32|int64|single|double|decimal)$|^(tiny|small|big|)int(eger)?$|^numeric|^decimal|^float|^real$|^money$|^monetary$|^number$/,
    'number',
  ],
  [/^(edm\.)?string$|^n?varchar|^n?char|^text$|^str$|^clob$/, 'string'],
];

export function typeClass(dataType?: string | null): TypeClass {
  if (!dataType) return 'unknown';
  const t = dataType.trim().toLowerCase();
  for (const [re, cls] of CLASSES) if (re.test(t)) return cls;
  return 'unknown';
}

/**
 * True when nothing known rules out these two columns being one key.
 *
 * Unknown is permissive on purpose: this rule may only ever REJECT a claim on
 * positive evidence of a mismatch. Refusing what it merely cannot read would
 * silently delete good relationships from every connector that does not
 * publish types.
 */
export function typesJoinable(a?: string | null, b?: string | null): boolean {
  const ca = typeClass(a);
  const cb = typeClass(b);
  if (ca === 'unknown' || cb === 'unknown') return true;
  return ca === cb;
}

/**
 * Which columns of a target entity could carry a key of this type.
 *
 * Only a type filter — deliberately. Narrowing further here would mean guessing
 * at what a key looks like from its NAME, which is the class of inference that
 * produced the defect in the first place. The profiler narrows the rest by
 * MEASURING uniqueness, which is what "is this a key?" actually means and is
 * already one of the three fixed FK rules.
 *
 * The rejected column is excluded: it is the one we know does not fit.
 */
export function joinableCandidates(
  sourceType: string | undefined | null,
  targetColumns: ReadonlyArray<{ name: string; dataType?: string }>,
  rejected?: string,
): string[] {
  return targetColumns
    .filter((c) => c.name !== rejected && typesJoinable(sourceType, c.dataType))
    .map((c) => c.name);
}
