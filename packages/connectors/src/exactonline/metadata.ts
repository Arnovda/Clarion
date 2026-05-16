/**
 * OData `$metadata` fetcher + parser for ExactOnline.
 *
 * Why this exists: when a `requiresSelect` entity (BankEntries,
 * TransactionLines, etc.) has zero rows in the user's division, the
 * `?$top=1` discovery returns no data and we can't infer the column
 * set from row #1. Without the schema we either skip the entity
 * entirely (user sees nothing in the catalog) or write a parquet
 * with one placeholder column (useless for understanding the table's
 * shape). Neither is satisfying when a business user asks "why does
 * Quotations show no quotes — what columns would we have if we
 * tracked them?".
 *
 * EO's OData v3 service exposes `/api/v1/{division}/$metadata` — a
 * single XML document (CSDL / Conceptual Schema Definition Language)
 * describing every entity type, every property, and every navigation
 * relationship in the service. One fetch per sync gives us a complete
 * schema atlas for every entity the user might have selected.
 *
 * Usage shape:
 *
 *   const md = await fetchODataMetadata(http, config, ctx);
 *   const schema = lookupEntitySchema(md, '/inventory/ItemWarehouses');
 *   // schema = [{ name: 'ID', edmType: 'Edm.Guid' }, ...]
 *
 * The cache is per-sync — instantiated once in `sync()` and passed
 * to every `syncOneEntity` call. We never persist it across syncs;
 * EO's metadata is large (~2-5 MB) and stable enough that re-fetching
 * once per sync is acceptable overhead.
 */

import { XMLParser } from 'fast-xml-parser';
import type { HttpClient } from '../HttpClient';
import type { ExactOnlineConfig } from './schema';
import type { Logger } from '../types';

/**
 * A single column on an EO entity.
 *
 *   • `name` — exact PascalCase as it appears in JSON payloads.
 *   • `edmType` — the OData primitive type (e.g. `Edm.String`,
 *     `Edm.Int32`, `Edm.DateTime`, `Edm.Guid`, `Edm.Double`,
 *     `Edm.Boolean`). Used to write a parquet column with the
 *     right native type — far better than letting DuckDB default
 *     everything to VARCHAR.
 *   • `nullable` — informational; EO marks most fields nullable.
 */
export interface ODataProperty {
  name: string;
  edmType: string;
  nullable: boolean;
}

/**
 * Schema atlas keyed by ENTITY SET name (the URL segment used in
 * /api/v1/{division}/{path}, e.g. "Accounts", "TransactionLines",
 * "ItemWarehouses"). The set name is what appears in entity.apiPath,
 * which is why we key on it — direct lookup, no extra mapping.
 */
export interface ODataMetadata {
  /** Map of EntitySet name → property list. */
  entities: Map<string, ODataProperty[]>;
}

/**
 * Fetch `$metadata` from the EO division root, parse the XML, and
 * return a navigable atlas. Throws on network/parse failure — caller
 * must decide whether to treat that as fatal or fall through with
 * an empty atlas (empty atlas just means "schema fallback unavailable
 * for this sync", which is non-fatal).
 */
export async function fetchODataMetadata(
  http: HttpClient,
  config: ExactOnlineConfig,
  log: Logger,
): Promise<ODataMetadata> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/api/v1/${encodeURIComponent(config.division)}/$metadata`;
  log.info('fetching OData $metadata for schema fallback');
  const resp = await http.request<string>({
    url,
    // EO returns XML; the HttpClient defaults to JSON. Override the
    // Accept header so we get the raw CSDL document.
    headers: { Accept: 'application/xml' },
  });
  const body = typeof resp.body === 'string' ? resp.body : String(resp.body);
  return parseODataMetadata(body);
}

/**
 * Pure parser — exposed for testing without an HttpClient roundtrip.
 *
 * The CSDL XML has roughly this shape (heavily abridged):
 *
 *   <edmx:Edmx ...>
 *     <edmx:DataServices>
 *       <Schema Namespace="Exact.Web.Api.Models...">
 *         <EntityType Name="Account">
 *           <Property Name="ID" Type="Edm.Guid" Nullable="false"/>
 *           <Property Name="Name" Type="Edm.String" Nullable="true"/>
 *           ...
 *         </EntityType>
 *         <EntityType Name="TransactionLine"> ... </EntityType>
 *       </Schema>
 *       <Schema Namespace="...">
 *         <EntityContainer ...>
 *           <EntitySet Name="Accounts" EntityType="...Account"/>
 *           <EntitySet Name="TransactionLines" EntityType="...TransactionLine"/>
 *           ...
 *         </EntityContainer>
 *       </Schema>
 *     </edmx:DataServices>
 *   </edmx:Edmx>
 *
 * Note the EntitySet name (plural, what we see in URLs) differs from
 * the EntityType name (singular). We build a map of set → type, then
 * look up the type's properties — both stitched together at parse time
 * so callers can lookup by set name directly.
 */
export function parseODataMetadata(xml: string): ODataMetadata {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Some CSDL elements appear once-per-document, others appear many
    // times. Force arrays for the ones we iterate so the code path is
    // uniform regardless of count.
    isArray: (name) => ['Schema', 'EntityType', 'Property', 'EntitySet', 'EntityContainer'].includes(name),
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to parse OData $metadata XML: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Walk down to the Schema array. The root element name varies between
  // EO regions (`edmx:Edmx`, `Edmx`); accept either.
  const root = (parsed['edmx:Edmx'] ?? parsed['Edmx']) as Record<string, unknown> | undefined;
  if (!root) {
    throw new Error('OData $metadata XML did not contain an Edmx root element');
  }
  const services = (root['edmx:DataServices'] ?? root['DataServices']) as Record<string, unknown> | undefined;
  if (!services) {
    throw new Error('OData $metadata XML did not contain a DataServices element');
  }
  const schemas = services['Schema'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(schemas) || schemas.length === 0) {
    throw new Error('OData $metadata XML did not contain any Schema elements');
  }

  // First pass: collect EntityType → properties keyed by FULL namespaced
  // name. EntitySet references EntityType by the namespaced name (e.g.
  // "Exact.Web.Api.Models.CRM.Account"), so we need that as the key.
  const typeProps = new Map<string, ODataProperty[]>();
  for (const schema of schemas) {
    const ns = String(schema['@_Namespace'] ?? '');
    const types = (schema['EntityType'] as Array<Record<string, unknown>> | undefined) ?? [];
    for (const t of types) {
      const typeName = String(t['@_Name'] ?? '');
      if (!typeName) continue;
      const fullName = ns ? `${ns}.${typeName}` : typeName;
      const props = (t['Property'] as Array<Record<string, unknown>> | undefined) ?? [];
      const properties: ODataProperty[] = props.map((p) => ({
        name: String(p['@_Name'] ?? ''),
        edmType: String(p['@_Type'] ?? 'Edm.String'),
        nullable: String(p['@_Nullable'] ?? 'true') !== 'false',
      })).filter((p) => p.name.length > 0);
      typeProps.set(fullName, properties);
    }
  }

  // Second pass: walk EntityContainer → EntitySet, mapping the set name
  // (which is what callers see in URLs) to its EntityType's properties.
  const entities = new Map<string, ODataProperty[]>();
  for (const schema of schemas) {
    const containers = (schema['EntityContainer'] as Array<Record<string, unknown>> | undefined) ?? [];
    for (const c of containers) {
      const sets = (c['EntitySet'] as Array<Record<string, unknown>> | undefined) ?? [];
      for (const s of sets) {
        const setName = String(s['@_Name'] ?? '');
        const entityType = String(s['@_EntityType'] ?? '');
        if (!setName || !entityType) continue;
        const props = typeProps.get(entityType);
        if (props) entities.set(setName, props);
      }
    }
  }

  return { entities };
}

/**
 * Look up the schema for an entity given its `apiPath` (relative,
 * with leading slash, as stored in `ExactOnlineEntity.apiPath`).
 *
 * The apiPath looks like `/inventory/ItemWarehouses` or
 * `/crm/Accounts`. The last segment IS the EntitySet name (EO is
 * consistent on this), so we just split + take the last piece.
 *
 * Returns undefined when the set isn't found in the atlas — typically
 * either a malformed apiPath or an EO release that renamed/removed
 * the entity. Callers should treat undefined as "no schema fallback
 * available, write a single-column placeholder parquet".
 */
export function lookupEntitySchema(
  md: ODataMetadata,
  apiPath: string,
): ODataProperty[] | undefined {
  const parts = apiPath.split('/').filter(Boolean);
  if (parts.length === 0) return undefined;
  const setName = parts[parts.length - 1];
  return md.entities.get(setName);
}
