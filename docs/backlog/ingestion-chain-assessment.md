# Ingestion-keten assessment — connectoren, bronlaag, topics, schema-evolutie en semantische metadata

**Datum:** 2026-09-09 · **Boom:** `035fdb2` (main, 2026-09-08) · **Methode:** vier onafhankelijke code-audits (connector-contract, sync/warehouse, bron→topics, semantische metadata), elk met `file:line`-bewijs, gekruist met externe research naar hoe Airbyte, Fivetran, dlt, Delta/Iceberg/DuckLake, ODCS en OSI/Ossie dezelfde problemen oplossen. De zwaarste claims zijn daarna met de hand herlezen in de code. Niets is tegen een live tenant gedraaid; waar een claim van runtime-gedrag afhangt, staat dat erbij.

**Vraag van de eigenaar:** *"Is het ingestion framework de beste opzet en future-proof voor 200+ connectoren? Doen we full load en dan mergen naar de topics, of overwrite? Is dit best practice? Wat met veranderende schema's (bron én topics)? En is de manier waarop we relaties en definities van bronsystemen opslaan DE beste manier, ook voor toekomstige bronnen?"*

Dit document vervangt niets: `docs/SOURCE_ONBOARDING.md` blijft het playbook per connector, `docs/incremental-sync.md` het cursor-contract, `docs/backlog/multi-source-strategy.md` de multi-source-strategie en `docs/backlog/SCD2.md` het historie-ontwerp. Het beantwoordt één vraag die daar nergens wordt gesteld: **draagt de keten die er nu staat 200 connectoren, en waar breekt hij eerst?**

---

## 0. Oordeel in acht zinnen

1. **Het connector-CONTRACT is goed en draagt 200 connectoren; de UITVOERINGSLAAG eronder is gebouwd voor vijf.** `SourceConnector` (drie verplichte methoden, vijf optionele semantische kanalen), het worker-isolatiemodel, de conformance-suite en het `declared > curated > ai_verified > ai_draft`-ladder zijn zeldzaam goed doordacht. Maar elke REST-connector schrijft zijn eigen transport (Odoo 566 regels, SharePoint 553), er is geen declaratief pad, geen plugin-model, geen connector-versie en één package voor alles.
2. **De bronlaag is "huidige stand, één parquet per entiteit", en incrementeel laden herschrijft bij elke sync het hele bestand** — op Azure inclusief download en upload van de volledige tabel. Dat is O(tabel) per run, niet O(delta), en botst met de harde 30-minutengrens per sync.
3. **Deletes komen nooit door.** Een rij die in de bron verdwijnt blijft in Clarion staan tot iemand handmatig een volledige re-sync start. Fivetran, dlt en Airbyte lossen dit standaard op met een soft-delete-kolom; Clarion heeft dat mechanisme niet.
4. **Het antwoord op "mergen of overwriten naar de topics" is: geen van beide in de betekenis die de vraag bedoelt.** Elke refresh herberekent de volledige transformatie-SQL over de volledige bron en overschrijft de topic-tabel integraal (`write_deltalake(mode="overwrite")`). Er is geen product-side watermark, geen incrementeel fact-model en geen historie. De sidecar berekent een diff (unchanged/updated/inserted/deleted) uitsluitend voor de grafiek.
5. **Schema-evolutie is op beide lagen impliciet in plaats van beleid.** Toegevoegde kolommen komen door, verwijderde kolommen blijven als all-NULL spoken staan (waardoor de drift-detectie ze niet ziet), en een verwijderde bronkolom die een topic gebruikt wordt door de AI-repair *weggeknipt en persistent gemaakt* zonder dat iemand het te zien krijgt. Er is geen contract tussen bron en topic en geen impact-analyse richting dashboards.
6. **Vier defecten zijn niet architectureel maar gewoon kapot en horen deze week gefixt**: geplande transformaties falen op een niet-bestaande kolom (`product_tables.product_id`), een bron-sync invalideert de DuckDB-pool en widget-cache niet (verse data tot 30 min onzichtbaar), kwaliteitschecks blokkeren nooit (een fact met dubbele grain publiceert gewoon), en de pipeline-runner bouwt facts door op een gefaalde bron-sync.
7. **De semantische opslag is inhoudelijk juist maar in de verkeerde vorm voor schaal**: de kennis over een bron (entiteiten, kolomdocs, relaties, business keys, types, star-template, KPI's) zit verspreid over vier tot zes TypeScript-bestanden met verschillende vormen, terwijl de profiler één ding consumeert. Voor bron #50 wil je één machine-leesbaar "source package" dat een generator of een niet-ontwikkelaar kan schrijven, met versie en herkomst — de ladder en de opslag in Postgres/Neo4j kunnen dan ongewijzigd blijven.
8. **Aanbeveling in één zin:** houd het contract, vervang de substraten — een declaratieve REST-kit met generator, een echte tabelformaat-laag met MERGE en soft-deletes voor de bron (DuckLake is de natuurlijke keuze naast DuckDB), stabiele hash-sleutels en incrementele facts voor de topics, en één versioned source-package-spec voor de semantiek — in de volgorde van §7, en fix de vier defecten vóór iets van dat alles.

---

## 1. De keten zoals hij vandaag staat

```
  Bronsysteem ──► Connector (packages/connectors, in worker-proces)
                    │  sync(): per entiteit rows als NDJSON → WarehouseWriter
                    ▼
  Bronlaag  ──── <root>/tenant_<t>/conn_<c>/<Entity>/data.parquet   (één parquet per entiteit)
                    │  ParquetWriter/BlobSasWarehouseWriter: overwrite of merge-by-key (volledige herschrijf)
                    │  cursors → entity_sync_cursors; run → source_sync_runs
                    ▼
  Catalogus ─── source_tables / source_columns / table_relationships (+ Neo4j-spiegel)
                    │  SchemaProfiler: structural (gratis) of full (docs → curated → AI)
                    ▼
  Ontwerp  ──── busMatrixBuilder: template (deterministisch) of AI-ontwerp → data_products / product_tables / product_columns / product_relationships
                    │
                    ▼
  Topics   ──── transformationRunner: DuckDB-sessie over ALLE bronviews → CREATE TABLE AS <sql> → Python-sidecar
                    │  write_deltalake(mode="overwrite", schema_mode="merge")   (Delta, SCD1, volledige herberekening)
                    ▼
  Lezen    ──── createProductConnector: views over product-Delta + rollups + grids → Ask AI / dashboards / notebooks
```

Een tweede, oudere keten leeft nog: directe databases (Postgres/MySQL/SQL Server/SQLite) gaan via `routes/ingestion.ts` naar de Python-ETL (`etl/main.py`) die Delta schrijft met een eigen watermark, eigen catalogus (`ingested_tables`), eigen reaper en eigen weekly compaction. Daar komen we in §3.5 op terug.

---

## 2. Deel A — Het connector-framework: draagt het 200+ connectoren?

### 2.1 Wat er staat (gemeten)

| Onderdeel | Omvang | Bewijs |
|---|---|---|
| Gedeeld framework (types, base, registry, ipc, HttpClient, twee writers, conformance, starSchema, spreadsheet-kern) | ~3.000 regels code | `packages/connectors/src/*` |
| CSV-connector (kleinste echte) | 306 regels, 3 bestanden | `csv/` |
| Excel | 247 regels | `excel/` |
| SharePoint | 799 regels, waarvan `graph.ts` 259 + `oauth.ts` 294 transport | `sharepoint/` |
| Odoo | 897 regels, waarvan **566 transport** (`json2Transport` + `xmlrpcTransport` + `xmlrpcCodec` + `transport`) | `odoo/` |
| Exact Online | 2.008 regels + 2.763 gegenereerde docs + 572 template | `exactonline/` |

**Het contract** (`types.ts:28-216`): verplicht zijn `type`, `displayName`, `configSchema`, `egressAllowList` en drie methoden — `testConnection`, `listEntities`, `sync`. Optioneel: `oauth`, `probeEntities`, `getKnownRelationships`, `getBusinessKeys`, `describeEntities`, `getStarSchemaTemplate`. Alleen `sync` draait in de worker (`worker/src/main.ts:151-156`); de rest wordt in-process door de backend aangeroepen voor de wizard en de profiler.

**Wat aantoonbaar goed is, en behouden moet blijven:**

- **De scheiding platform/connector rond cursors** (`docs/incremental-sync.md`): het platform bewaart, geeft door en merget; de connector interpreteert. Monotoniciteit wordt aan twee kanten afgedwongen (`ExactOnlineConnector.ts:384`, `SyncOrchestrator.ts:189-204`).
- **De worker is dun en stateloos** (279 regels, `worker/src/main.ts`): connector instantiëren, sync draaien, JSON-lines op stdout, exit. Geen HTTP, geen database. Secrets via 0600-bestand of tijdelijke blob-SAS, cancel via SIGTERM. Dit is exact het isolatiemodel dat Airbyte (één container per sync) en Fivetran hanteren.
- **De conformance-suite** (`conformance.ts`, 287 regels) dwingt invarianten af die anders bugs zouden zijn: `incrementalCursor ⇒ businessKey` (de "table wipe"-invariant, `:152-154`), beschrijving verplicht, relatie-eindpunten bestaan en zijn typecompatibel (`:203-249`).
- **De semantische kanalen** (`describeEntities`, `getKnownRelationships`, `getBusinessKeys`, `unresolvedReferences`, `getStarSchemaTemplate`) — geen enkele mainstream ELT-tool geeft een connector een plek om *betekenis* mee te leveren. Dit is Clarions onderscheidend vermogen en verdient het om als data-formaat te worden gestandaardiseerd (Deel E).
- **`>=`-cursor + merge-by-key**, streaming rijen, `failedEntities` → `partial`, `preservedExisting` bij lege responses: elk van deze regels is een bug die ooit is geschipt en nu structureel dicht zit.

### 2.2 Wat ontbreekt om naar 200 te gaan (gerangschikt)

1. **Geen generieke transport-kit: elke REST-connector bouwt paginering, auth en foutafhandeling opnieuw.** `BaseSourceConnector.paginate` is `protected static` en wordt door EO via `BaseSourceConnector['paginate']` benaderd (`ExactOnlineConnector.ts:456`); Odoo rolt een eigen offset-loop (`OdooConnector.ts:232-255`). `HttpClient` (459 regels) heeft retry/backoff, `Retry-After`, 401-refresh, single-flight pacing en de egress-allowlist, maar **geen** declaratieve paginators (offset/page/cursor/link/next-token), geen JSON-path record-selector, geen OAuth client-credentials, geen GraphQL, geen SQL/JDBC-kit. Bij 300–600 regels transport per connector is dit bij 200 connectoren de dominante kost: 60.000–120.000 regels handgeschreven transport.
2. **Geen declaratief pad en geen plugin-model.** Registratie is een statische `Map` met handmatige side-effect-imports (`registry.ts:19`, `index.ts:99-106`, met `// import './netsuite'; // future` als placeholder). Geen manifest, geen runtime-laden, geen `version`-veld op de interface, één `@databridge/connectors@0.1.0` voor alles. Airbyte's eigen conclusie na honderden connectoren: de Connector Builder (YAML-manifest) "should be enough for 90% connectors out there" ([airbyte-python-cdk](https://github.com/airbytehq/airbyte-python-cdk)); dlt bouwt een REST-bron uit één declaratief config-object met `client`/`resource_defaults`/`resources`, auto-gedetecteerde paginering, `write_disposition: merge` en zelfs `strategy: scd2` ([dlt rest_api](https://dlthub.com/docs/dlt-ecosystem/verified-sources/rest_api/basic), [merge loading](https://dlthub.com/docs/general-usage/merge-loading)), en genereert die config uit een OpenAPI-spec met heuristieken voor paginering, primary keys en JSON-path ([dlt-init-openapi](https://github.com/dlt-hub/dlt-init-openapi)).
3. **De egress-allowlist wordt alleen in `HttpClient` afgedwongen en op vijf plaatsen omzeild**: `exactonline/oauth.ts:64,184` en `sharepoint/oauth.ts:80,253` (bare `axios.post` met client secret), `ExactOnlineConnector.ts:970` (native `fetch` voor probes), `worker/src/main.ts:206` (config-blob). `types.ts:45-47` belooft dat de lijst NSG/Container Apps-regels voedt; `infra/main.tf` bevat geen egress-regel. Bij 200 connectoren is "de kit is de enige muur" geen houdbare stelling.
4. **Rate-limiting is per `HttpClient`-instantie, per proces** (`HttpClient.ts:145-148`). Twee tenants op dezelfde Exact-app in twee worker-processen delen niets; een vendor-quotum per app is onbeheerd. Fivetran en Airbyte houden quota per *vendor-app*, niet per sync.
5. **Geen opgenomen fixtures / cassettes.** Tests zijn handgeschreven `nock`-antwoorden in drie suites; "Live sandbox validation" is een handmatig vinkje in de Definition of Done (`SOURCE_ONBOARDING.md`). Bij 200 connectoren wil je record/replay tegen een sandbox-account, anders is elke connector-upgrade een blinde push.
6. **Onbegrensd DuckDB-geheugen in de worker-writer** (`ParquetWriter.ts:184,241`; `BlobSasWarehouseWriter.ts:209,279`): geen `memory_limit`/`threads`, anders dan de backend-sessies (`applyResourceGuardrails`). Een grote merge in een 1-vCPU-jobcontainer is een OOM-risico.
7. **~200 regels merge-kern staan twee keer** — `ParquetWriter.ts:157-346` en `BlobSasWarehouseWriter.ts:183-357`, "kept in sync; library-isolated copy" (`:186`). Eén writer met een pluggable storage-backend is de voor de hand liggende samenvoeging, en verdwijnt sowieso bij de tabelformaat-keuze van §3.
8. **Conformance ziet geen runtime-gedrag**: dat `sync()` daadwerkelijk `mergeKey`/`columns`/`replace` doorgeeft, dat cursors worden geëmit, dat `ColumnDoc.name` op echte parquet-headers matcht, of dat template-SQL uitvoert (`starSchema.ts:190-193` is een `^(SELECT|WITH)`-regex) wordt nergens gecheckt. Elke connector moet bovendien zijn ruwe catalogus zélf exporteren om door de suite gevonden te worden (`conformance.ts:121-125`).

### 2.3 Hoe de industrie 500–700 connectoren draagt

De drie referentiepunten hebben elk 550–700 connectoren ([Fivetran 700+, Meltano 600+, Airbyte 550+](https://estuary.dev/blog/airbyte-alternatives/)), en geen van hen doet dat met handgeschreven transport per bron:

| | Airbyte | dlt | Fivetran | Clarion vandaag |
|---|---|---|---|---|
| Definitie van een REST-bron | YAML-manifest (declarative components: requester, authenticator, paginator, record selector, incremental sync, partition router, error handler) | Python-dict `rest_api_source` (client, resources, paginator, incremental, `write_disposition`) | Gesloten; Connector SDK voor klanten | Handgeschreven TypeScript per bron |
| Generatie uit spec | Connector Builder UI, OpenAPI-import, AI-assist | `dlt-init-openapi` (paginering, PK, JSON-path, auth via heuristiek) | n.v.t. | Geen |
| Protocol tussen connector en platform | AirbyteCatalog (JSON Schema per stream) + AirbyteRecord/State-messages | Schema + `schema_contract` per resource | Intern | `EntityDescriptor` (naam, cursor, key — **geen kolommen**) + IPC-events |
| Deletes | Per-connector; CDC voor databases | `merge` + `hard_delete`/`dedup_sort` hints | Soft delete `_fivetran_deleted` als standaard; History Mode = SCD2 | Alleen via handmatige full re-sync |
| Schema-evolutie | Catalog refresh, per-stream schema-versie | `schema_contract` (evolve/freeze/discard) per resource | Widening ja, narrowing nee, verwijderde kolom blijft met NULL; `schema_change_handling` ALLOW_ALL/ALLOW_COLUMNS/BLOCK_ALL | Impliciet via `UNION BY NAME` + CAST |

Het patroon is eenduidig: **een klein aantal handgeschreven "custom" connectoren voor de lastige gevallen (databases, binaire protocollen, RPC), en een declaratief manifest plus generator voor de lange staart van REST-API's.** Clarions eigen vijf connectoren illustreren de verdeling al: CSV/Excel zijn triviaal, SharePoint en Exact zijn "gewone" REST-API's die in een manifest passen, Odoo (XML-RPC + JSON-2) is het custom-geval.

### 2.4 Aanbeveling voor Deel A

**A1 — Een `RestSourceKit` in het bestaande package** (niet een nieuw framework): declaratieve paginators (offset, page, cursor-in-body, next-link, header-token), authenticators (bearer, API-key, OAuth auth-code met rotatie, OAuth client-credentials, basic), record-selector (JSON-path), incremental (datetime/integer-cursor, `>=`-regel ingebakken), flattening-regels, en een per-entiteit foutbeleid. `ExactOnlineConnector` en `SharePointConnector` worden daarna manifest + ~50 regels overrides; Odoo blijft custom. Dit is het dlt/Airbyte-model in TypeScript, met Clarions bestaande `HttpClient` als onderlaag — en het sluit meteen de vijf allowlist-bypasses, want de kit is dan het enige HTTP-pad.

**A2 — Een `connector.manifest.json` (of YAML) als primaire definitie**, met `version`, `configSchema`, `egressAllowList`, entiteiten (naam, cursor, key, kolommen met brontype), relaties, business keys en een verwijzing naar docs/template. De registry laadt manifesten; TypeScript-connectoren registreren zich ernaast voor het custom-geval. Dit is ook de bestandsvorm waar Deel E op uitkomt: het manifest IS het source package.

**A3 — Een generator-pad**: OpenAPI-spec → manifest-concept (paginering, PK, record-path via heuristieken, zoals `dlt-init-openapi` doet) → mens beoordeelt → conformance. Voor API's zonder OpenAPI kan een LLM het concept schrijven; de conformance-suite en een record/replay-test tegen een sandbox zijn dan de poort, niet de prompt.

**A4 — Record/replay-fixtures** (cassettes per connector, opgenomen tegen een sandbox-account, met redactie) als verplichte DoD-stap in plaats van "live sandbox validation" als vinkje.

**A5 — Versie en packaging**: `version` op het contract, één package per connector-familie of een `connectors/<type>/` met eigen `package.json`, en een configSchema-migratiehaak (`migrateConfig(from, to)`) zodat een schema-wijziging een bestaande verbinding niet breekt.

**A6 — Kleine, directe fixes**: `memory_limit`/`threads` in de worker-writer; alle HTTP door `HttpClient` (of een `rawFetch`-helper met dezelfde allowlist); één quota-store (Redis-tokenbucket per vendor-app, dezelfde infra als de rate-limit-store van P1-2).

---

## 3. Deel B — De bronlaag: full load, incrementeel, merge, deletes

### 3.1 Wat er feitelijk gebeurt

- **Drie laadmodi per entiteit**, beslist door de `EntityDescriptor` (`types.ts:472-517`): `always-full` (geen cursor), `initial-full` (cursor gedeclareerd, nog niets opgeslagen) en `incremental`. Exact Online: 50 incrementeel / 11 full; Odoo: alle 21 incrementeel op `write_date`; Excel, CSV en SharePoint: altijd full (`supportsIncremental: false`). **De aanname "we doen nu full load" klopt dus alleen voor de bestandsbronnen** — de API-connectoren zijn al incrementeel.
- **"Full" = overwrite van één parquet-bestand** (`ParquetWriter.ts:140-142`), met de guard dat nul rijen over een bestaand bestand het oude bestand bewaren (`:103-116`).
- **"Incrementeel" = volledige herschrijf van het bestand.** `mergeNdjsonIntoExistingParquet` (`ParquetWriter.ts:225-346`) kopieert het bestaande bestand naar tmp, doet `existing UNION ALL BY NAME delta`, dedupliceert met `ROW_NUMBER() OVER (PARTITION BY key ORDER BY _origin DESC)` en schrijft alles terug. De Azure-variant **downloadt eerst de hele blob en uploadt daarna het hele resultaat** (`BlobSasWarehouseWriter.ts:118-119,163`). Voor `TransactionLines` ("tens of millions of rows", `exactonline/entities.ts:28-29`) betekent een nachtelijke delta van 10.000 rijen: de volledige tabel twee keer over het netwerk.
- **Full re-sync** wist de cursors vóór de start (`SyncOrchestrator.ts:303-310`), zet `WORKER_FULL_RESYNC=1` en de connector schrijft met `replace: true` (`ExactOnlineConnector.ts:521-523`). Dit is het enige pad waarlangs een in de bron verwijderde rij uit Clarion verdwijnt.
- **Deletes komen anders nooit door** — expliciet een non-goal (`docs/incremental-sync.md:170-184`, `ParquetWriter.ts:96-99`). Geen tombstones, geen soft-delete-kolom, geen periodieke sleutel-reconciliatie, geen geplande full re-sync.
- **Geen historie op de bronlaag**: één `data.parquet` per entiteit, in place herschreven. Geen snapshots, geen Delta-versies op dit pad (Delta is alleen voor topics). Een crash midden in een entiteit trekt die entiteit de volgende run opnieuw (cursor pas bij voltooiing bewaard, `SyncOrchestrator.ts:449-454`); een crash tussen `unlink` en `rename` laat de tabel kortstondig afwezig (`ParquetWriter.ts:339-345`).
- **Harde grens van 30 minuten** per sync (`SyncOrchestrator.ts:64`; `infra/main.tf:1229` `replica_timeout_in_seconds = 1800`, `replica_retry_limit = 0`) zonder hervatting. De eigen documentatie schat een initiële load van een grote EO-divisie op "uren" (`incremental-sync.md:10-14`). Die initial load kan dus per definitie niet slagen voor de grootste entiteiten, en herstart elke run van nul.
- **Een bron-sync invalideert niets.** `SyncOrchestrator.ts` bevat geen `invalidateWarehouse`, `publishInvalidation` of `widgetCache`-aanroep (grep leeg), terwijl `duckdb.ts:167,189` object- en HTTP-metadata-cache aanzet en `DuckDBPool.ts:26` sessies 30 minuten vasthoudt. Omdat het bestands-URI na een merge ongewijzigd is, kan een gepoolde sessie tot 30 minuten oude parquet-metadata blijven serveren; de widget-cache (5 min) overleeft een sync eveneens. De legacy ingestion-route doet het wél (`ingestion.ts:278`). Concreet: "Sync complete" op het scherm en tot een half uur later nog oude cijfers op het dashboard.
- **Geplande syncs synchroniseren altijd álle geselecteerde entiteiten** (`workers.ts:558` geeft geen `entities` mee); per-entiteit-cadans bestaat alleen als ad-hoc API-body. Geen backfill per periode, geen replay.
- **Observability-gaten**: `entity_sync_cursors.last_status/last_error` en `source_sync_runs.job_execution_name` worden nergens geschreven (grep leeg); tabellen uit het connector-pad hebben `rowCount: null` in de catalogus (`tableCatalog.ts:247`) — alleen `source_sync_runs.row_counts` (JSON) weet hoeveel rijen er zijn.

### 3.2 Is dit best practice?

Deels. De *contracten* rond de writer zijn precies wat de industrie doet: `>=`-cursor met idempotente merge-by-key is de dlt/Airbyte-regel voor tweede-precisie watermarks, "lege response mag geen tabel wissen" is een Fivetran-invariant, en `partial` als status met per-entiteit-fouten is beter dan wat Airbyte standaard geeft. Het *substraat* is niet best practice, om drie redenen:

1. **Een merge hoort O(delta) te zijn.** Iedere tabelformaat-laag (Delta, Iceberg, DuckLake) doet een `MERGE` door alleen de geraakte bestanden/row-groups te herschrijven en de rest via metadata te hergebruiken. Een single-file rewrite is de implementatie die je kiest voor een prototype en die je vervangt zodra de eerste tabel groter is dan het geheugen van de worker.
2. **Deletes horen een standaardmechanisme te hebben.** Fivetran markeert een verwijderde rij als `_fivetran_deleted = TRUE` in plaats van hem te verwijderen, en bij een re-sync zet het alles wat niet opnieuw gezien is op deleted ([Fivetran soft delete](https://fivetran.com/docs/core-concepts/syncoverview/sync-modes/soft-delete)). dlt heeft `hard_delete`-hints en `merge` met `scd2`. Voor API's die geen deletes exposen (de meeste) is de reconciliatie-run (sleutels ophalen, verschil markeren) het gangbare antwoord; Fivetran zegt zelf dat het voor die API's deletes niet ziet en documenteert dat ([deleted source data](https://fivetran.com/docs/destinations/troubleshooting/deleted-source-data)). Clarion heeft géén van beide: geen kolom, geen reconciliatie.
3. **Historie op de bronlaag is optioneel, maar de mogelijkheid moet bestaan.** Fivetran History Mode en dlt `scd2` bewaren elke versie van een rij. Clarion overschrijft in place; SCD2 op topics (`docs/backlog/SCD2.md`) kan later nooit terugkijken naar bronversies die er niet meer zijn.

### 3.3 Aanbeveling voor Deel B: een tabelformaat-laag met MERGE en soft-deletes

**B1 — Kies één tabelformaat voor de bronlaag en laat de writer daarop `MERGE` doen.** Twee kandidaten passen in de bestaande stack:

| | Delta Lake (nu al voor topics, via Python-sidecar) | DuckLake (DuckDB-native, v1.0 april 2026) |
|---|---|---|
| Schrijver | `deltalake` Python-rust; per tabel een subprocess (`deltaWriter.ts:204-253`) | DuckDB zelf: `INSERT`, `UPDATE`, `DELETE`, `MERGE` in SQL ([DuckLake](https://ducklake.select/)) |
| Catalogus | `_delta_log` op blob | Postgres (die Clarion al heeft), DuckDB of SQLite |
| Schema-evolutie | `schema_mode=merge` (toevoegen); drop/rename vereist column mapping; type-narrowing faalt | Add/drop/rename/type-promotie via `ALTER TABLE` ([schema evolution](https://ducklake.select/docs/preview/duckdb/usage/schema_evolution.html)) |
| Time travel / snapshots | Ja | Ja, plus data inlining voor kleine updates (geen small-files-probleem, [data inlining](https://ducklake.select/2026/04/02/data-inlining-in-ducklake/)) |
| Lezen vanuit DuckDB | `delta_scan` (extensie, in Azure-modus nu een falende round-trip per registratie, `views.ts:92-96`) | Native |
| Risico | Bewezen, breed ecosysteem; maar Python-sidecar per tabel blijft | Jong (v1.0 april 2026); ecosystem = DuckDB/MotherDuck; catalog-DB wordt kritisch pad |

**Advies: DuckLake voor de bronlaag én de topics, in twee stappen.** De hele query-engine is al DuckDB, de catalogus-database is al Postgres, en DuckLake geeft in één keer wat nu over drie mechanismen verspreid is: O(delta)-merge, ACID-schrijven zonder unlink/rename-venster, deletes als DML, snapshots/time travel (de bronhistorie die SCD2 later nodig heeft), en schema-evolutie als expliciete `ALTER`. De Python-sidecar (één proces per tabel, 15-min timeout) en de dubbele parquet-merge-kern verdwijnen. Het eerlijke risico is de leeftijd van het formaat; de mitigatie is dat DuckLake-data gewoon parquet is met een Postgres-catalogus, dus een terugweg naar Delta bestaat. Zolang dat niet is gevalideerd: Delta met `MERGE` via de sidecar is het conservatieve alternatief met dezelfde semantiek en meer procesoverhead.

**B2 — Soft-delete als platformconventie**: twee technische kolommen op elke brontabel, `_clarion_synced_at` en `_clarion_deleted` (Fivetran-vocabulaire, Clarion-naam), achter de bestaande `is_technical`-firewall zodat ze nooit in prompts of UI verschijnen. Semantiek: een incrementele sync zet `_clarion_deleted = false` op alles wat het ziet; een full re-sync markeert alles met `_clarion_synced_at < start` als deleted in plaats van het te verwijderen; een nieuw `reconcile`-sync-mode haalt per entiteit alleen de sleutels op (goedkoop bij de meeste API's; EO's `$select=ID`) en markeert het verschil. De DuckDB-views filteren `_clarion_deleted = false` standaard; een topic dat verwijderde rijen wíl zien (annuleringen) kan er expliciet om vragen. Dit maakt "rijen verdwenen in de bron" van een handmatige, dure actie een geplande, goedkope.

**B3 — Hervatbare initial loads**: cursor of pagina-checkpoint per entiteit persisteren tijdens de run (niet alleen bij voltooiing), zodat een 30-minuten-kill hervat in plaats van herstart; en een sync die de grens nadert netjes stoppen met "resume later" in plaats van een SIGKILL.

**B4 — Invalideren na een sync** (één regel, vandaag): `invalidateWarehouse(connection)` + `publishInvalidation` in `SyncOrchestrator` na de cursor-persist, zoals `transformationRunner.ts:896,922` al doet.

**B5 — Per-entiteit cadans en backfill**: een sync-schema per entiteit (of per categorie: masterdata dagelijks, transacties elk uur), en `backfill(entity, from, to)` als expliciete operatie voor bronnen met een tijdfilter.

**B6 — Per-entiteit rijtelling en laatste-status persistent maken** (`entity_sync_cursors.last_status/last_error` schrijven, `rowCount` in de catalogus vullen) — de velden bestaan, alleen de schrijver ontbreekt.

### 3.4 Wat te doen met het legacy ETL-pad

Het Python ETL-pad (`routes/ingestion.ts` → `etl/main.py`) is nog volledig live voor directe databases: eigen watermark-CDC (`WHERE col > value` zonder ordening, `etl/main.py:305-307`), **append zonder dedupe bij incrementeel** (`:387-391`, dus bijgewerkte rijen worden gedupliceerd), eigen catalogus `ingested_tables`, eigen reaper op `connections.created_at` (`reapers.ts:59-72`) en een wekelijkse `/optimize`. De `IngestionWizard` wordt nog steeds op `/sources` gemount (`frontend/app/sources/page.tsx:8`). Er bestaan daarmee **vijf** implementaties van "schrijf een tabel naar het warehouse" (twee parquet-writers, de Python `_write_delta`, `writeRowsParquet` voor grids/producten, de Delta-sidecar) en **twee** broncatalogi.

**Advies: bouw de vier directe-database-connectoren (Postgres, MySQL, SQL Server, SQLite) als `SourceConnector`s in het framework en schakel het Python-pad uit.** Een `SqlSourceKit` (introspectie via `information_schema`, cursor op een timestamp- of id-kolom, `businessKey` = primary key, later log-based CDC) is precies de "SQL/JDBC-kit" die in §2.2 ontbreekt, en directe databases zijn de enige Tier-3-bron waarvoor de echte primary key en kolomcommentaren via introspectie beschikbaar zijn — de business-key-heuristiek uit 2026-09-01 kan daar dan verdwijnen. Daarna: `ingested_tables` migreren naar `connections.selected_entities`, de ETL-container en dbt-runner verwijderen (dbt is aantoonbaar dood: `USE_DBT_TRANSFORMATIONS` staat nergens aan, RFC-001 is "Proposed (not implemented)").

---

## 4. Deel C — Van bronlaag naar topics: overwrite, merge, of iets anders?

### 4.1 Het antwoord op de vraag

**Elke refresh is een volledige herberekening en een volledige overwrite.** `runProductTransformation` (`transformationRunner.ts:359`) opent een DuckDB-sessie, registreert *alle* bronviews (`:453-511`) en de dimensies van upstream-producten (`:174-208`), voert per tabel `CREATE OR REPLACE TABLE __temp_<name> AS <transformation_sql>` uit (`:661`) — de hele SELECT over de hele bron — en schrijft het resultaat via de Python-sidecar met `write_deltalake(mode="overwrite", schema_mode="merge")` (`commit_table.py:566-572`). De sidecar zegt het zelf: "SCD1: the dim is fully overwritten with the new state" (`:10-11`). De diff-tellingen (unchanged/updated/inserted/deleted, `:342-434`) worden berekend door oude en nieuwe `_row_hash` te vergelijken, en dienen uitsluitend de grafiek — niets handelt ernaar.

Er is dus **geen merge naar de topics en geen product-side watermark**. De enige incrementele tak (`load_mode==='incremental'`, `:813-844`) is op het standaardpad onbereikbaar (de Delta-tak eindigt met `continue` op `:806`) én wordt nergens meer gezet (de `/load-mode`-route is op 2026-09-07 verwijderd; alleen `busMatrixBuilder.ts` schrijft `'full'`). De bron is incrementeel, de topics zijn dat niet: een 15-minuten-broncadans zou elke 15 minuten het hele warehouse herberekenen.

### 4.2 Is full recompute verkeerd?

Niet per se — en dat is belangrijk om eerlijk te zeggen. Voor SMB-volumes (honderdduizenden tot enkele miljoenen factregels) is een volledige herberekening per nacht simpel, deterministisch en idempotent: geen watermark-bugs, geen late-arriving-data-problemen, geen partitie-administratie. dbt's eigen advies is "start with a full refresh, go incremental when it hurts". Het probleem is niet dat Clarion full recompute doet, maar dat **de architectuur incrementeel nooit toelaat**, om drie redenen die elk op zichzelf een fout zijn:

1. **Surrogaatsleutels zijn `ROW_NUMBER()`** in het AI-ontwerppad (`busMatrixPrompt.ts:155,247,256`; de repair-prompt bewaart dit, `AIService.ts:2393`). Een `ROW_NUMBER` wordt per run opnieuw geteld: één toegevoegde klant vóór een gegeven natuurlijke sleutel verschuift alle latere sleutels. Gevolgen vandaag: (a) de sidecar-diff sleutelt op de surrogaat, dus een dim-insert leest als massa-delete+insert in de veranderingsgrafiek; (b) een fact in product B dat `customer_key` tegen de dim van product A resolveerde, houdt oude sleutels tot B zélf herbouwd is — `runProductRefreshWorkflow` ververst precies één product (`busMatrixOrchestrator.ts:808-935`), dus per-product-refresh van een eigenaar-dim breekt stilzwijgend elke afhankelijke fact-join tot de afhankelijken draaien; (c) niets buiten de run kan een sleutel vasthouden. De templates doen het goed: natuurlijke sleutels (`exactonline/starSchemaTemplate.ts:42-45`, `role: 'natural_key'`). De twee ontwerp-paden zijn het dus oneens over de belangrijkste modelleerkeuze.
2. **Er is geen product-side watermark of partitie** — geen `updated_since`, geen `date_key`-partitie, geen `is_incremental()`-equivalent. Kimball-praktijk voor facts is "append/merge op grain per periode"; dbt's `merge`/`delete+insert`/`microbatch` doen precies dat.
3. **Er is geen historie.** `mode` is hard `'scd1'` (`deltaWriter.ts:61,135`; `commit_table.py:455-463`), `product_columns.scd_type` wordt altijd als 1 geschreven (`busMatrixBuilder.ts:637`), `SCD2.md` is backlog. Delta's time travel staat aan maar wordt nergens gebruikt.

### 4.3 De vier defecten die vandaag kapot zijn

> **Status 2026-09-09:** alle vier, plus de drie dual-write-lekken (E2) en de `memory_limit` in de worker-writer, zijn gefixt in dezelfde PR als dit document (fase 0 van §7). Zie de CLAUDE.md-entry van die datum voor wat precies is gebouwd en getest.

Deze horen niet in een roadmap maar in de volgende PR:

1. **Geplande transformaties falen altijd.** `processTransformationJob` laadt tabellen met `trx('product_tables').where({ product_id: productId })` (`workers.ts:181`), maar `product_tables` heeft geen `product_id`-kolom — alleen `star_schema_id` (`20260402000017_create_data_products.ts:36`; geen latere migratie voegt er een toe). Elke cron-run (`scheduler.ts:57` → queue `scheduled-transformation` → `workers.ts:436`) en elke handmatige run via `routes/schedules.ts:191-193` landt als `failed` in `transformation_runs` met een Postgres undefined-column-fout. Geen test dekt het; het SchedulePanel is op 2026-09-06 verwijderd, dus de feature is tegelijk kapot en onbereikbaar. De pipelines (`busMatrixOrchestrator.ts:408,660`, via `star_schema_id`) werken wél — dat is waarom niemand het merkte. *Geverifieerd door de migratie en de worker met de hand te lezen.*
2. **Kwaliteitschecks blokkeren nooit.** `runTransformationChecks` (BK-uniciteit, fan-out, referentiële integriteit, waardebereik) draait in een try/catch die alleen `log.warn`t (`transformationRunner.ts:722-726`), waarna `publishProductTable` gewoon volgt (`:781`). Een fact met dubbele grain publiceert naar elk dashboard. Fan-out is bovendien wiskundig identiek aan BK-uniciteit (`transformationChecks.ts:152-238` vs `:64-146`).
3. **De pipeline-runner bouwt facts door op een gefaalde bron-sync.** `runPipelineWorkflow` registreert een mislukte/partiële bron (`busMatrixOrchestrator.ts:640-700`) maar raadpleegt `sourceResults` niet bij het starten van de producten — alleen het eind-`allOk` (`:726`). De orchestrator zelf weigert wél on-source-sync-triggers na een partiële sync (`SyncOrchestrator.ts:676-681`), precies om deze reden. De twee paden spreken elkaar tegen.
4. **Een leeg resultaat maakt een topic leeg.** De bron-writers bewaren een bestaand bestand bij nul rijen; de product-writer doet `dt.delete()` bij nul rijen op refresh (`commit_table.py:540-564`). Een bron die tijdelijk niets teruggeeft (of een `WHERE` die door een verwijderde kolom weggerepareerd is) wist het topic.

### 4.4 Rebuild, extend en curatie

**Rebuild = retire-and-replace**: elk product op de verbinding waarvan het nieuwe ontwerp de naam hergebruikt wordt `DELETE`d (`busMatrixBuilder.ts:487-518`, `:510`) en cascadeert door de hele boom. `snapshotProductEdits` (`:388-435`) draagt op naam vier dingen over: `hidden`, `plain_summary`, `question_text` en hand-gemaakte KPI's. **Niet** overgedragen: `product_columns`-bewerkingen (display name/description uit de catalogus), de refinement-log (`product_customizations`, waarvan de migratie-header claimt dat hij "bus-matrix re-run preservation" voedt maar die `buildBusMatrix` nooit leest), `transformation_schedules` (cascade-delete), refresh-historie en veranderingsgrafiek, en de Neo4j-productgraaf. Dashboards bewaren `spec.productIds` (`dashboards.ts:163-169`); een verouderd id filtert naar niets in `buildProductSemanticContext` (`productContext.ts:126-153`) → stille terugval naar de bronlaag (de D3-vorm uit de coherence review). Op het AI-pad kan een rebuild bovendien tabel- en kolomnamen wijzigen, waarna elk opgeslagen artefact op de oude namen breekt. Oude `product_<oldId>`-mappen blijven als wezen achter (`:505-507`); niets veegt ze op.

**Extend** (`runTopicExtensionWorkflow`, `prepareExtensionMatrix` `:104-192`) is het enige id-behoudende wijzigingspad en is goed ontworpen: één product, `build_order=2`, harde fout op naamconflict zodat de retire-sweep nooit kan afgaan.

### 4.5 Aanbeveling voor Deel C

> **Status 2026-09-09 (fase 1 gebouwd):** C1 is de *natuurlijke* sleutel, niet een hash — de templates deden dat al, en DuckDB's `hash()` is niet gegarandeerd stabiel over versies. De AI-prompts vragen erom, en `validateBusMatrix` WEIGERT een `surrogate_key`/`foreign_key` die per run vernummert (`ROW_NUMBER`/`UUID`/`RANDOM`/`NEXTVAL`), zowel in de kolomexpressie als in de SQL-alias. D3-helft: `schemaLoss.ts` + `product_tables.degraded_reason`; E5: `shared/provenance.ts`; E6: `source_columns.source_data_type` + `type-mismatch` op het canvas. Details in de CLAUDE.md-entry van die datum.

**C1 — Stabiele sleutels, één regel voor beide paden**: surrogaatsleutel = deterministische hash van de natuurlijke sleutel (`hash(natural_key)` als BIGINT, of gewoon de natuurlijke sleutel zelf zoals de templates doen). In de prompt, in de repair-prompt en in `validateBusMatrix` als afdwingbare regel (weiger `ROW_NUMBER` in een `surrogate_key`-expressie). Dit is de voorwaarde voor alles hieronder en voor de multi-source-crosswalk (§2.2 van de multi-source-strategie).

**C2 — Incrementele facts als opt-in per tabel**: `product_tables.incremental_strategy` (`full` | `merge_on_key` | `append_by_period`) + `watermark_column`. De runner filtert de bron-view op `_clarion_synced_at > last_run` (B2 levert die kolom) en doet een `MERGE` op de sleutel in plaats van overwrite. Dimensies blijven full (klein), facts worden merge. Met DuckLake is dat één SQL-statement; met Delta één sidecar-call met `mode=merge`.

**C3 — Kwaliteitspoorten die iets doen**: `severity: block | warn` per check, standaard `block` voor BK-uniciteit en referentiële integriteit op facts; een geblokkeerde tabel houdt de vorige `delta_path` (dat mechanisme bestaat al: `markProductTableFailed` laat de oude URI staan) en meldt het op het topic. De rijtelling-delta uit de sidecar wordt een check ("meer dan 50% van de rijen verdwenen → block").

**C4 — SCD2 waar het telt**: `scd_type = 2` per dimensie honoreren (klant-, product- en GL-dims zijn de kandidaten), met `valid_from/valid_to/is_current` en een hash-diff — de sidecar heeft de diff al. Met DuckLake-snapshots op de bronlaag kan historie zelfs met terugwerkende kracht worden opgebouwd.

**C5 — Rebuild bewaart identiteit**: upsert op `(connection_id, product name)` en `(product, table_name)`, `product_columns`-bewerkingen en schedules in de snapshot, en een orphan-sweeper voor `product_<oldId>`-mappen in `warehouseMaintenance`.

**C6 — De vier defecten uit §4.3** vóór alles: kolomfout in de worker (één regel: `star_schema_id IN (select id from star_schemas where data_product_id = ?)`), blokkerende checks, `sourceResults`-gate in de pipeline-runner, preserve-on-empty in de sidecar.

---

## 5. Deel D — Veranderende schema's, op beide lagen

### 5.1 Wat er nu gebeurt, per wijzigingstype

| Wijziging in de bron | Bronlaag (parquet-merge) | Catalogus | Topics |
|---|---|---|---|
| Kolom toegevoegd | Verschijnt; oude rijen NULL (`UNION ALL BY NAME`, `ParquetWriter.ts:301-323`) | `schema_hash` wijzigt → `schema_changes`-rij + admin-notificatie "klaar voor analyse" (`SyncOrchestrator.ts:1054-1077,1118-1129`); `source_columns` pas bijgewerkt na handmatige Analyse | Onzichtbaar tot iemand het topic uitbreidt; bij `SELECT *`-ontwerpen komt de kolom ongedocumenteerd het topic binnen |
| Kolom verwijderd | **Blijft staan als all-NULL** (nooit gedropt bij incrementeel) | **Hash wijzigt niet** (de kolom staat nog in het bestand) → geen detectie, geen notificatie | Transformatie-SQL faalt op Binder-error → **AI-repair knipt de referentie weg en persisteert de nieuwe SQL** (`AIService.ts:2387-2388`, `transformationRunner.ts:718-720`); `syncProductColumns` laat de productkolom bestaan (Delta `schema_mode=merge` houdt hem) → topic wordt stilzwijgend smaller |
| Kolom hernoemd | Add + remove (bij full-entiteiten); bij incrementeel: nieuwe kolom erbij, oude blijft NULL | Als "toegevoegd" | Als "verwijderd" — de repair verwijdert de oude referentie; de nieuwe naam wordt niet gekoppeld |
| Type verbreed (INT → BIGINT, DECIMAL-precisie) | Met `columns`: bestaande zijde `CAST` naar het gedeclareerde type (`:268-299`); zonder: DuckDB-supertype | Hash wijzigt → notificatie | Meestal transparant |
| Type versmald of onverenigbaar | `CAST` (niet `TRY_CAST`) faalt de entiteit luid — bewust | Idem | Delta `SchemaMismatchError` op de commit → tabel `failed`, vorige versie blijft leesbaar |
| Entiteit toegevoegd | Alleen als geselecteerd in de wizard | Structurele registratie bij eerste sync | Niet in het ontwerp tot rebuild/extend |
| Entiteit verwijderd/verboden bij de vendor | `failedEntities` → run `partial`, alert | — | Facts blijven op de laatste sync draaien; pipeline bouwt door (§4.3-3) |

En op de topic-laag zelf: `syncProductColumns` (`transformationRunner.ts:76-149`) verwijdert productkolommen die niet meer in DESCRIBE staan (`DELETE`, cascadeert `column_lineage` — beschrijving, rol, FK-metadata weg) of, op het Delta-pad, houdt ze als spook; nieuwe kolommen landen als `attribute`, lege beschrijving, `ai_draft=true`. Niets loopt daarna de consumenten na: `saved_questions.tables_used` en dashboard-specs bevatten SQL-tekst en tabelnamen, maar er is geen impact-analyse (grep op `tables_used` vindt alleen prompt-output en het provenance-endpoint). Een dashboard, opgeslagen vraag of notebook op een verdwenen kolom faalt bij de volgende uitvoering met een Binder-error, waarna de read-side self-heal de query mogelijk *herschrijft* in plaats van te melden dat het topic veranderd is.

**Er is geen contract tussen bron en topic.** `data_product_sources` bewaart alleen tabelnamen (`20260402000017:91-96`), `EntityDescriptor` heeft geen kolommen, en drift levert alleen "re-analyse"-notificaties op. De onderliggende ontwerpfout is dat schema-evolutie **emergent** is uit `UNION BY NAME`, `schema_mode=merge` en de AI-repair, in plaats van **beleid** dat per wijzigingstype zegt wat er gebeurt en wie het hoort.

### 5.2 Hoe de industrie het doet

- **Fivetran**: kolom toegevoegd → komt mee (instelbaar: `ALLOW_ALL` / `ALLOW_COLUMNS` / `BLOCK_ALL`); kolom verwijderd → blijft bestaan met NULL vanaf dat moment; type verbreed → bestemming volgt; type versmald → bestemming volgt *niet*; onverenigbaar → oude kolom blijft, nieuwe kolom erbij. Nooit data droppen ([schema changes](https://www.fivetran.com/blog/schema-changes), [schema config](https://fivetran.com/docs/getting-started/fivetran-dashboard/connectors/schema)).
- **dlt**: `schema_contract` per resource met `evolve` / `freeze` / `discard_row` / `discard_value` per niveau (tables, columns, data_type) — evolutie is een keuze, geen toeval.
- **Data contracts (ODCS v3.1, Linux Foundation/Bitol)**: één YAML per dataset met schema, kwaliteitsregels (`rowCount`, `unique`, `freshness`), SLA en eigenaar; consumenten valideren ertegen ([ODCS](https://bitol-io.github.io/open-data-contract-standard/v3.1.0/), [v3.1.0](https://bitol.io/bitol-announces-odcs-v3-1-0-stronger-smarter-and-stricter/)).
- **dbt**: `contract: enforced` op een model = het model mag zijn kolommen/types niet veranderen zonder een versie; `versions:` op modellen; consumenten kiezen een versie.

### 5.3 Aanbeveling voor Deel D: schema-evolutie als beleid

**D1 — Een schema-registry per entiteit**: `source_entity_schemas (connection_id, entity, version, columns jsonb {name, source_type, landing_type}, seen_at)`. De writer schrijft er een nieuwe versie in bij elke waargenomen wijziging; drift wordt daarmee een *diff tussen versies* in plaats van een hash-vergelijking op een bestand dat verwijderde kolommen verbergt. Dit is ook het `AirbyteCatalog`-equivalent dat een connector in §2.4 (A2) meelevert.

**D2 — Een beleid per wijzigingstype, standaard Fivetran-conservatief**: toegevoegd → mee, ongedocumenteerd gemarkeerd en in de review-queue; verwijderd → bewaard als NULL *en* gemarkeerd `retired_at` in de registry (zodat de drift-detectie hem wél ziet); type verbreed → volgen; versmald/onverenigbaar → nieuwe kolom naast de oude, nooit een `CAST` die de entiteit laat falen. Per tenant instelbaar (`allow_all` / `allow_columns` / `block_all`) voor wie zekerheid wil.

**D3 — Impact-analyse vóór de run, niet repair erna**: bij een registry-diff de transformatie-SQL van elk afhankelijk product parsen (de `sqlProvenance`/`column_lineage`-machinerie bestaat) en de `saved_questions`/dashboard-widgets die de kolom noemen opsommen. Het resultaat is een notificatie met namen ("Sales gebruikt `Accounts.Phone`, dat Exact niet meer levert; 3 dashboards raken dit") en een keuze, niet een AI die de referentie 's nachts weghaalt. **De AI-repair van een verdwenen bronkolom moet stoppen met persisteren**: repareren in-memory voor déze run mag, maar de tabel krijgt status `degraded` met de weggehaalde kolom bij naam, tot een mens beslist.

**D4 — Contract op de topic-laag**: elk product krijgt een expliciet, versioned kolomcontract (ODCS-vorm past letterlijk: schema + quality + SLA + owner) dat `syncProductColumns` niet stilzwijgend mag wijzigen. Een run die het contract breekt blokkeert (C3) in plaats van kolommen te verwijderen; een bewuste wijziging bumpt de versie en loopt de consumenten na (D3).

**D5 — Bronversie-bewustzijn**: `connections.source_version` (Odoo 16 vs 19, EO API-versie) en per manifest/template een `targets:`-veld, zodat "dit veld bestaat pas vanaf Odoo 17" een feit in data is en niet een `not_found` bij de probe.

---

## 6. Deel E — Relaties, definities en templates van bronsystemen: is dít de manier?

### 6.1 Wat er staat

**Opslag.** Een semantisch feit ("kolom X betekent Y", "A.col → B.col is een sleutel") leeft in Postgres (`source_tables`, `source_columns`, `table_relationships`, met `semantic_source`, `ai_draft`, `approval_status`, `edited_by_user`/`confirmed_by_user`, `vendor_description`, en op relaties `kind`, `measured`, `flagged_at`) én in Neo4j (`SourceTable`/`SourceColumn`/`RELATES_TO`, met een *subset* van die velden: geen `vendor_description`, `edited_by_user`, `kind`, `measured`, `semantic_source` op edges — `semanticGraph.ts:1950-2074`). Een bronkolom-beschrijving bestaat drie keer (Postgres `description`, `vendor_description`, Neo4j), plus een vierde in `definition_versions` zodra iemand hem bewerkt. Op de productlaag: `product_tables`, `product_columns`, `product_relationships`, `column_lineage` (op naam), `product_kpis`, gespiegeld in Neo4j.

**Kanalen** (in de volgorde van de ladder): runtime-harvest (Odoo `fields_get`: `help` → beschrijving, `relation` → relatie met `toColumn: 'id'` hard-coded, `OdooConnector.ts:410-463`; Exact `$metadata` alleen voor schrijftypes); build-time curatie (`exactonline/docs.ts`: 2.763 regels, 61 entiteiten, 2.613 kolommen, 246 referenties, deterministisch gegenereerd uit vendor-HTML door `generate-eo-docs.ts`; hand-geschreven relaties: EO 69, Odoo 50); heuristische FK-detectie met containment-verificatie (`fkVerification.ts:274-305`) en de meting van vendor-referenties met een type-conflict (`referenceResolution.ts:111-189`, "precies één kandidaat mag slagen"); de 3-pass AI (`schemaContextPrompt.ts`); menselijke bewerkingen (snapshot-and-merge, `SchemaProfiler.ts:847-920`); en de tenant-glossary (vrije tekst in elke prompt, `glossaryContext.ts:52-66`, zonder koppeling aan kolommen).

**Consumptie.** Het product-laag-prompt leest uitsluitend Postgres (`productContext.ts:156-283`); het bron-laag-prompt en de ontwerper lezen Neo4j (`routes/query.ts:623`, `busMatrixOrchestrator.ts:203-206`). De dual-write is dus in beide richtingen dragend.

### 6.2 Wat inhoudelijk goed is

De *ideeën* zijn de juiste, en beter dan wat mainstream tooling doet:

- **Documentatie vóór inferentie** met een expliciete herkomstladder, opgeslagen per rij. Airbyte en Fivetran hebben helemaal geen semantisch kanaal; dbt heeft er een (yml) maar zonder herkomst.
- **Vendor-referenties worden gemeten, niet geloofd**: `unresolvedReferences` + `referenceResolution` (35 van 245 EO-referenties kruisten een typegrens en zouden als "laid by the source" op het canvas hebben gestaan). Dit is een zeldzaam eerlijke constructie.
- **Menselijke bewerkingen overleven een re-profile** (migratie 70), en `kind = join | match` scheidt een FK van een identiteitsbewering tussen bronnen — de fout die multi-source-tooling meestal maakt, is hier van meet af aan vermeden.
- **Business keys komen uit de bron** (`getBusinessKeys`), niet uit een uniciteits-gok.

### 6.3 Wat niet klopt

1. **De vorm is code, niet data, en het is vier vormen.** `docs.ts` (`Record<entity, ColumnDoc[]>`), Odoo's `docs.ts` (`Record<model, Record<field, string>>` — geen type, geen rol, geen referentie), `entities.ts` (`EntityDescriptor[]` + `KNOWN_RELATIONSHIPS[]`) en `starSchemaTemplate.ts` (`StarSchemaTemplate`) beschrijven één bron in vier structuren, met de entiteitsnaam als enige (string-)sleutel — hoofdlettergevoelig op de ene plek (`SchemaProfiler.ts:252`) en niet op de andere (`declaredBusinessKeys.ts:44`). Templates dragen eigen beschrijvingen en lineage die niet naar `docs.ts` verwijzen: een tweede hand-geschreven kopie. Voor bron #50 vereist dit TypeScript-imports, een conformance-test, `tsc` en een `dist`-publicatie; een niet-ontwikkelaar of een generator kan het niet schrijven. Alleen EO heeft een generator, en die kent één vendor-HTML-layout (`generate-eo-docs.ts:80,107-119`).
2. **Geen versie van vendorkennis.** Eén datumstempel ("Transcribed 2026-07-20", `docs.ts:22`); templates `version: 1` zonder upgrade-pad (`template_version` wordt alleen getoond, `buildOverview.ts:131`); Odoo "16+" is een commentaar (`entities.ts:13-14`).
3. **Definitiehistorie raakt los bij elke Analyse.** `definition_versions.entity_id` is het Postgres-rij-id, en de profiler wist en her-insert de rijen bij elke re-profile (`SchemaProfiler.ts:1013-1045`), zodat de historie wees wordt (de PATCH-route zoekt `old` op `entity_id` en vindt niets, `routes/semantic.ts:337-339`).
4. **Twee herkomst-vocabulaires en geen `human`-rung.** Tabellen/kolommen: `declared | curated | ai | ai_enriched | NULL`; relaties: `vendor_docs | curated | declared | name_pattern | value_overlap | ai_suggested | ai_model` (`…000079:22-28`). Menselijke eigendom is een aparte boolean, dus een bewerkte kolom houdt `semantic_source='ai'` (`SchemaProfiler.ts:907-908`); `ai_verified` is nergens onderscheidbaar van `ai_draft` in opslag (`:1129-1130`).
5. **De dual-write lekt op drie plekken** — en elk lek degradeert het AI-prompt van een gedocumenteerde tenant zonder dat iets het meldt. *Geverifieerd in de code:* (a) **Bevestigen vanuit `/review` maakt de Neo4j-beschrijving leeg**: de queue PATCHt `{ai_draft:false, approval_status:'approved'}` (`frontend/app/review/page.tsx:52`), de route geeft de body ongewijzigd door aan `graph.updateColumn` (`routes/semantic.ts:342`), wiens Cypher `description = $description ?? null` SET (`semanticGraph.ts:330-345`). Postgres houdt de tekst, Neo4j verliest hem, en Neo4j is wat het bron-laag-prompt leest. Zelfde vorm op tabellen. (b) **`PATCH /semantic/product-columns` schrijft alléén de graaf** (`routes/semantic.ts:1860-1865`) terwijl het product-laag-prompt alléén Postgres leest (`productContext.ts:263`): de enige bewerkingsplek voor productkolommen bereikt de AI nooit. (c) Bevestigde relaties dupliceren in Neo4j bij re-profile (alleen `aiDraft:true`-edges worden gewist, `semanticGraph.ts:2057`, alles wordt met `aiDraft:true` herschreven, `:2073`, inclusief de herstelde bevestigde rijen, `SchemaProfiler.ts:1268-1282`).
6. **Het oorspronkelijke brontype gaat verloren.** `source_columns.data_type` is het DuckDB-landingstype (`SchemaProfiler.ts:1057,1317`); `Edm.Guid` bestaat alleen in `docs.ts` als "informational", Odoo's `fields_get`-type wordt weggegooid (`OdooConnector.ts:436-441`). Na landing zijn een GUID en een code beide VARCHAR, dus `typeClass` (`columnTypes.ts:46-63`) kan alleen vóór de profile in het connector-package vuren en nooit een relatie beschermen die later op het canvas wordt getekend. Geen eenheid, valuta, precisie of enum-waarden ergens.
7. **Vier relatie-waarheden zonder afleiding**: `table_relationships`, Neo4j `RELATES_TO` (zonder `kind`/`measured`), `product_relationships` en `product_columns.fk_target_*` (plus `topics-graph` dat joins uit die laatste her-afleidt). Herkomst sterft aan de productgrens: de ontwerper krijgt relaties als proza-regels (`busMatrixOrchestrator.ts:206-212`). Een bevestigde `match`-edge zou het bron-laag-prompt bereiken als gewone join, omdat de edge geen `kind` draagt.
8. **De glossary is vrije tekst zonder kolom- of metriekkoppeling**; KPI's zijn per-product `formula_sql`-strings; er is geen manier om een afgeleid bedrijfsbegrip ("openstaande vordering = `TransactionLines WHERE …`") op de bronlaag uit te drukken; de tien vaste dimensienamen uit §5.8 van de multi-source-strategie zijn nergens code (de templates zeggen nog `dim_partner`/`dim_account`, en `dim_account` betekent Partij in EO en GL-rekening in Odoo).

### 6.4 Hoe de industrie het doet (ter vergelijking, uit eigen kennis)

dbt legt sources/models/columns/tests in YAML met `version:`; MetricFlow en de dbt Semantic Layer voegen entities, dimensions, measures en metrics als declaratieve spec toe. Airbyte publiceert per connector een JSON-Schema-catalogus met per-stream cursor en primary key. OpenMetadata heeft een versioned entiteitenmodel met glossary-term → kolom-koppelingen, tags, OpenLineage-lineage en change-events. **En sinds januari 2026 is er een open standaard voor precies de laag waar Clarion zijn onderscheid heeft**: de Open Semantic Interchange (OSI, nu Apache Ossie (Incubating), Snowflake/Salesforce/dbt/Databricks) — een Apache-2.0 YAML-spec voor datasets, metrics, dimensions, relationships en context, met converters naar dbt, GoodData, Polaris en Salesforce ([OSI v1.0](https://open-semantic-interchange.org/updates/), [Apache Ossie](https://www.snowflake.com/en/blog/apache-ossie-open-semantic-interchange-incubator/), [dbt over OSI](https://www.getdbt.com/blog/the-osi-spec-updates)).

### 6.5 Aanbeveling voor Deel E

**E1 — Eén declaratief "source package" per bron, als data met een JSON Schema** — dít is het belangrijkste structurele voorstel in dit document. Eén `source.package.json` (of YAML) met: `version`, `vendor` (naam, API-/docs-versie, datum), `entities[]` (naam, displayName, beschrijving, categorie, cursor, businessKey, `columns[]` met `sourceType`, `landingType`, beschrijving, rol, `references`, `enum`, `unit`/`currency`), `relationships[]` (met `provenance` en beschrijving), `starTemplate` (dims/facts/products/kpis, met verwijzing naar entiteiten en kolommen in hetzelfde bestand in plaats van kopieën), en `glossary[]` (bron-eigen begrippen: "Division", "GL classification"). `describeEntities`, `getKnownRelationships`, `getBusinessKeys` en `getStarSchemaTemplate` worden dunne loaders over dit bestand; het manifest uit A2 is dezelfde file of verwijst ernaar. De conformance-suite valideert tegen het JSON Schema. **Waarom dit alles ontgrendelt:** een generator (OpenAPI-spec, vendor-HTML, `fields_get`-dump, of een LLM met de vendor-docs als bron) schrijft data in plaats van TypeScript; een reviewer leest een diff van feiten in plaats van code; en bron #50 heeft dezelfde vorm als bron #1. Vertaal het intern naar OSI/Ossie-constructen waar ze bestaan (datasets, dimensions, metrics, relationships), zodat een export naar dbt of een toekomstige BI-integratie gratis is.

**E2 — Fix de drie dual-write-lekken deze week** (a: `updateColumn`/`updateTable` alleen SETten wat in de patch zit; b: `PATCH /semantic/product-columns|tables` naar Postgres spiegelen; c: bij re-profile de bevestigde edge upserten op `pgId` in plaats van een nieuwe naast de oude te zetten).

**E3 — Postgres als enige semantische waarheid, Neo4j afgeleid (of weg).** Het product-laag-prompt bewijst al dat elk pad vanuit Postgres bediend kan worden; de graaf voegt alleen join-path-zoeken toe, dat DuckDB of een recursieve CTE ook kan. Zolang Neo4j blijft: één schrijver (een `syncGraphFromPostgres(entity)` na elke Postgres-mutatie) in plaats van dual-write per route. Dit sluit de hele klasse van lekken uit §6.3-5 en maakt het dual-write-contract in CLAUDE.md overbodig.

**E4 — Stabiele identiteit bij re-profile**: upsert op `(connection_id, table_name)` en `(table_id, column_name)` in plaats van wipe-and-reinsert, zodat `definition_versions`, ownership-gates en graaf-`pgId`s stoppen met verspringen.

**E5 — Eén herkomst-vocabulaire met expliciete `human`- en `ai_verified`-rungs**, op tabellen, kolommen en relaties, en meegedragen in `product_relationships`/`column_lineage`.

**E6 — Bewaar het brontype** (`source_columns.source_data_type`) en enum-waarden; maak `typeClass` bruikbaar ná landing, zodat het canvas een GUID→code-relatie kan weigeren.

**E7 — Glossary → kolom/metriek-koppeling en een metriekspec** (measure/dimension/entity, MetricFlow- of OSI-vorm), zodat "openstaande vordering" een eersteklas begrip op de bronlaag is en niet een zin in een prompt; en codeer de tien vaste dimensienamen uit de multi-source-strategie als data in de templates, met de bekende `dim_account`-botsing als eerste rename.

---

## 7. Roadmap: wat eerst, wat daarna

Volgorde op afhankelijkheid en op *wat vandaag fout gaat*, niet op ambitie. Inschattingen zijn ordes van grootte, voor één ervaren ontwikkelaar.

| Fase | Wat | Waarom eerst | Orde |
|---|---|---|---|
| **0 — Deze week** ✅ *gebouwd 2026-09-09* | §4.3-1 kolomfout in de transformatie-worker; §3.1 invalidatie na sync (B4); blokkerende checks (C6); `sourceResults`-gate in de pipeline-runner; preserve-on-empty in de sidecar; de drie dual-write-lekken (E2); `memory_limit` in de worker-writer | Alles hier is kapot of lekt vandaag; niets ervan is architectuur | 2–3 dagen |
| **1 — Sleutels en beleid** ✅ *gebouwd 2026-09-09* | Stabiele hash-/natuurlijke sleutels in beide ontwerp-paden (C1); AI-repair van verdwenen bronkolommen niet meer persisteren, tabel `degraded` (D3-helft); één herkomst-vocabulaire (E5); brontype bewaren (E6) | Voorwaarde voor incrementeel, SCD2, crosswalk en impact-analyse; kleine wijzigingen met grote hefboom | 1 week |
| **2 — Het tabelformaat** | DuckLake (of Delta-MERGE) voor bron én topics; soft-delete-conventie + `reconcile`-mode (B2); hervatbare loads (B3); één writer; Python-sidecar weg | Lost O(tabel)-merge, deletes, 30-min-grens, historie en de dubbele writer in één beweging op; alles daarna bouwt erop | 3–4 weken, incl. migratie van bestaande data (eenmalige re-sync per tenant is acceptabel — er zijn nog geen betalende klanten en één connector per tenant) |
| **3 — Schema als beleid** | Schema-registry per entiteit (D1), beleid per wijzigingstype (D2), impact-analyse vóór de run (D3), productcontract (D4), bronversie (D5) | Maakt "veranderende schema's" van een verrassing een melding met namen | 2–3 weken |
| **4 — Incrementele topics** | `incremental_strategy` per tabel met MERGE op sleutel (C2); SCD2 op de gekozen dims (C4); rebuild met identiteit + orphan-sweep (C5) | Pas zinvol met stabiele sleutels (1) en een MERGE-substraat (2) | 2–3 weken |
| **5 — Het source package** | JSON-Schema-spec (E1); loaders; conformance ertegen; EO en Odoo omzetten; generator uit OpenAPI/`fields_get`/vendor-docs; glossary→kolom en metriekspec (E7) | De vorm die bron #6 t/m #200 aankunnen; kan parallel aan 2–4 omdat het de opslag niet raakt | 3–4 weken |
| **6 — De REST-kit** | `RestSourceKit` + manifest (A1/A2); EO en SharePoint erop; record/replay-fixtures (A4); versie/packaging (A5); quota-store (A6); `SqlSourceKit` voor de vier directe databases en het Python-ETL-pad uit (§3.4) | Pas zinvol als het package (5) er is — anders standaardiseer je transport terwijl de semantiek nog code is | 4–6 weken |
| **7 — Volume** | Generator-pad met LLM-assist (A3), community-/partnerconnectoren, log-based CDC voor databases | Dit is waar 200 een getal wordt in plaats van een ambitie | doorlopend |

Wat *niet* in deze volgorde staat, en waarom: **connector #6 bouwen vóór fase 5** — elke connector die nu in de oude vorm wordt geschreven moet later worden omgezet; **SCD2 vóór stabiele sleutels** — historie op instabiele sleutels is ruis; **de query-laag un-scopen als onderdeel hiervan** — dat is de multi-source-strategie en staat er los van, al leunt de crosswalk op C1.

---

## 8. Wat NIET te doen

- **Niet naar Airbyte/Meltano/dlt overstappen als runtime.** Ze lossen transport en laden op, maar hebben geen plek voor de semantische kanalen die Clarions onderscheid zijn; je zou het package (E1) er alsnog bovenop bouwen, met een tweede runtime en een tweede proces- en secretsmodel. Leen hun *vorm* (declaratief manifest, catalog-per-stream, write-disposition), niet hun binaire.
- **Niet Iceberg.** Het lost hetzelfde op als DuckLake/Delta met veel meer bewegende delen (catalog-service, Avro/JSON-metadata, compaction-jobs) voor een team van deze omvang; Clarions eigen storage-analyse kwam tot dezelfde conclusie.
- **Geen AI-repair die persisteert bij schema-verlies.** Repair van een compileerfout in een AI-geschreven query is legitiem; een verdwenen bronkolom is een feit dat een mens moet zien (D3).
- **Geen tweede semantische opslag erbij** (bijvoorbeeld een vector-store voor beschrijvingen) vóór Postgres de enige waarheid is (E3). Drie kopieën zijn al twee te veel.
- **Geen full-load-only "omdat het simpel is" voor de bestandsbronnen** — daar is het correct: een upload heeft geen cursor en geen deletes-feed; de re-upload ís de refresh. Simpelheid hoort daar te blijven.
- **Niet de conformance-suite verzwakken om een connector sneller te mergen.** Het is de enige plek waar het playbook meer is dan een intentie.

---

## 9. Grenzen van dit onderzoek

- Niets is tegen een live tenant gedraaid. Elke claim is gelezen in de code op `035fdb2`; de zwaarste (worker-kolomfout, graph-nulling, product-column-schrijfpad, ROW_NUMBER-sleutels, overwrite-modus, ontbrekende invalidatie) zijn twee keer gelezen — door een audit en daarna door de hand.
- De externe vergelijking steunt op openbare documentatie en zoekresultaten; `airbyte.com`, `docs.airbyte.com`, `dlthub.com` en `fivetran.com` zijn geblokkeerd door de egress-policy van deze omgeving, dus die claims komen uit GitHub-mirrors en secundaire bronnen en zijn daarom als "industrie-patroon" en niet als citaat te lezen.
- DuckLake v1.0 is vijf maanden oud. De aanbeveling om ernaar te gaan is een architectuurkeuze die een proof-of-concept tegen echte tenant-data verdient vóór fase 2 start: één EO-tenant, `TransactionLines`, een nachtelijke incrementele MERGE, gemeten looptijd en geheugengebruik in de jobcontainer.
- De inschattingen in §7 zijn ordes van grootte; fase 2 en 6 hebben elk een migratie van bestaande data of connectoren in zich die groter kan uitvallen.

---

## Bronnen

- Airbyte Python CDK / low-code: [github.com/airbytehq/airbyte-python-cdk](https://github.com/airbytehq/airbyte-python-cdk); [Connector Builder](https://docs.airbyte.com/platform/connector-development/connector-builder-ui/overview); [low-code CDK](https://docs.airbyte.com/platform/connector-development/config-based/low-code-cdk-overview); [maintaining hundreds of API connectors](https://airbyte.com/blog/maintaining-hundreds-of-api-connectors-with-the-low-code-cdk-and-connector-builder)
- dlt: [REST API source](https://dlthub.com/docs/dlt-ecosystem/verified-sources/rest_api/basic); [incremental loading](https://dlthub.com/docs/general-usage/incremental-loading); [merge loading / scd2](https://dlthub.com/docs/general-usage/merge-loading); [dlt-init-openapi](https://github.com/dlt-hub/dlt-init-openapi); [OpenAPI source generator](https://dlthub.com/docs/dlt-ecosystem/verified-sources/openapi-generator)
- Fivetran: [How to think about schema changes](https://www.fivetran.com/blog/schema-changes); [connection schema config](https://fivetran.com/docs/getting-started/fivetran-dashboard/connectors/schema); [soft delete mode](https://fivetran.com/docs/core-concepts/syncoverview/sync-modes/soft-delete); [history mode](https://fivetran.com/docs/core-concepts/syncoverview/sync-modes/history-mode); [deleted source data](https://fivetran.com/docs/destinations/troubleshooting/deleted-source-data)
- Connector-aantallen: [Estuary — Airbyte alternatives 2026](https://estuary.dev/blog/airbyte-alternatives/); [Fivetran vs Airbyte 2026](https://dataopsleadership.substack.com/p/fivetran-vs-airbyte-in-2026-complete)
- DuckLake: [ducklake.select](https://ducklake.select/); [schema evolution](https://ducklake.select/docs/preview/duckdb/usage/schema_evolution.html); [data inlining](https://ducklake.select/2026/04/02/data-inlining-in-ducklake/); [DuckLake v1.0](https://duckdblab.org/en/post/ducklake-v1-intro/); [lakehouse table formats in 2026](https://dev.to/alexmercedcoder/lakehouse-table-formats-in-2026-iceberg-delta-lake-hudi-paimon-and-ducklake-how-they-work-p1k); [DuckLake vs Iceberg — Definite](https://www.definite.app/blog/duck-lake-vs-iceberg)
- Data contracts: [ODCS v3.1.0](https://bitol-io.github.io/open-data-contract-standard/v3.1.0/); [Bitol announces v3.1.0](https://bitol.io/bitol-announces-odcs-v3-1-0-stronger-smarter-and-stricter/); [ODCS in DataHub](https://docs.datahub.com/docs/generated/ingestion/sources/odcs)
- Semantische standaard: [Open Semantic Interchange updates](https://open-semantic-interchange.org/updates/); [Apache Ossie](https://www.snowflake.com/en/blog/apache-ossie-open-semantic-interchange-incubator/); [dbt over de OSI-spec](https://www.getdbt.com/blog/the-osi-spec-updates)
