# Plan: storage- & compute-isolatie voor honderden tenants

**Datum:** 2026-07-23 · **Status:** voorstel, wacht op akkoord eigenaar
**Aanleiding:** de zwakheden uit `docs/storage-competitive-analysis.md` §5: (1) productie
draait shared-container met padprefix-isolatie terwijl per-tenant containers gebouwd maar
uit staan; (2) alle query-/transformatie-compute van alle tenants deelt één Express-proces
zonder timeout, cancel of fairness.
**Basis:** twee diepe codebase-audits (2026-07-23) van alle DuckDB-executiepaden en alle
`WAREHOUSE_CONTAINER_MODE`-callsites. Alle feiten hieronder zijn geverifieerd met
file:line-referenties in de audits; de belangrijkste staan inline.

---

## 1. Welke aspecten hebben we nodig? (de eisen-inventaris)

Voordat je een oplossing kiest moet vastliggen wát opslag en compute op dit platform
moeten kunnen. Dit is de volledige lijst; elke ontwerpkeuze hieronder verwijst ernaar.

### 1.1 Opslag-eisen

| # | Eis | Status vandaag |
|---|---|---|
| S1 | **Harde tenant-grens** op de datalaag (storage weigert cross-tenant access, niet alleen code) | ✗ shared container, padprefix in code; worker-SAS is container-breed |
| S2 | **Leescompatibiliteit**: bestaande data blijft leesbaar bij elke wijziging (URIs staan absoluut in `connections.warehouse_path` / `product_tables.delta_path` en worden verbatim gelezen) | ✓ geverifieerd: geen leespad herberekent Azure-URIs uit env |
| S3 | **Offboarding/GDPR**: volledige, auditeerbare wissing per tenant in één operatie | ± `deleteTenantWarehouseContainer` bestaat en is aangesloten op `purgeTenant` (settings-route), maar werkt alleen in per-tenant mode |
| S4 | **Schaal**: honderden tenants zonder architectuurwijziging (containers per account: onbeperkt; account: 5 PiB / 20k req/s) | ✓ één account volstaat ruim |
| S5 | **Consistent auth-model**: least-privilege per werklast | ✗ worker = SAS (goed); backend-DuckDB, Python-sidecar én containercreatie draaien allemaal op de account-key (account-breed) |
| S6 | **Container-lifecycle**: race-veilige creatie, naamvalidatie (3–63 chars), memoisatie | ± `createIfNotExists` idempotent; geen naamvalidatie |
| S7 | **Kostenattributie per tenant** (blob-metrics zijn account-level) | ✗ niet aanwezig |
| S8 | **Bescherming**: soft-delete 30d, versioning, GRS | ✓ account-level aanwezig |
| S9 | **Migratiepad legacy-data** zonder big-bang | ± incrementeel model gedocumenteerd (re-sync/refresh verhuist data), geen backfill-script |
| S10 | **Valideerbaarheid**: een omgeving om de flip te testen | ✗ geen staging-tfvars/-infra; "staging" is een 0%-traffic-revisie op prod-resources |

### 1.2 Compute-werklasten (wat moet er draaien)

Uit de executie-audit — alles draait vandaag in het backend-proces behalve C6:

| # | Werklast | Aard | Latency-eis | Zwaarte |
|---|---|---|---|---|
| C1 | Dashboard widgets (`batch-execute`, ongelimiteerde `Promise.all`), Ask-AI-queries, entity-preflight, drilldowns | interactief | sub-seconde – enkele sec | licht–middel, cachebaar (widgetCache, rollups, DuckDBPool) |
| C2 | Repair-loop / investigate (SSE, multi-turn agentic SQL) | interactief | seconden per stap | middel |
| C3 | Notebook-SQL (verse `:memory:`-DuckDB per request, registreert de héle catalogus aan views, arbitraire SQL) | interactief | seconden | middel–zwaar |
| C4 | Transformaties/bus-matrix (volledige materialisatie), maandrollups, schema-profiler (value-overlap-joins), quality-profiling (**nu synchroon in de HTTP-handler!**), e-mailrapporten, morning brief, warehouse-maintenance | batch | minuten oké | zwaar |
| C5 | Dashboard-XLSX-export: her-draait álle widget-SQL, onbegrensd aantal rijen | semi-interactief | tientallen sec oké | middel–zwaar |
| C6 | Source-syncs | batch | minuten | ✓ al geïsoleerd (ACA Jobs, ephemeral, SAS-scoped) |

### 1.3 Isolatie-eigenschappen die compute nodig heeft

| # | Eigenschap | Status vandaag |
|---|---|---|
| I1 | **Crash-isolatie**: een DuckDB-segfault (corrupt parquet, extensie) mag de API niet doden | ✗ in-process → hele backend down |
| I2 | **Geheugenbudget**: begrensd per werklast, globaal kloppend | ✗ `memory_limit 70%` geldt **per instantie**; pool is unbounded → N instanties × 70% op 1 GiB |
| I3 | **Timeout + cancel per query** | ✗ bestaat niet — geen `withTimeout` op het hot path, geen `interrupt()`, geen Express-timeout; runaway query draait tot einde of OOM |
| I4 | **Fairness tussen tenants** (concurrency-caps) | ✗ geen enkele semaphore; alleen BullMQ-worker-concurrency voor batch |
| I5 | **Resultaatkanaal met lage latency** voor interactief werk | ✓ in-process (dat willen we behouden voor C1/C2) |
| I6 | **Cross-proces cancellation/events** | ✗ registry is in-memory single-process (code flagt zelf "replace with Redis pub/sub") |
| I7 | **Kostenbeheersing**: scale-to-zero-filosofie zoveel mogelijk behouden | ✓ huidig ~€30–60/mnd; plan verhoogt dit bewust beperkt |
| I8 | **Observability**: per query tenant/duur/uitkomst loggen | ± request-logging bestaat; geen query-granulariteit |
| I9 | **Betrouwbare job-queue**: geplande jobs overleven een restart | ✗ Redis draait zonder persistentie |

---

## 2. Ontwerpkeuze in één zin

**Storage:** activeer het al gebouwde per-tenant-containermodel (Microsoft's aanbevolen
middenmodel; sterker dan wat ClickHouse Cloud/Tinybird doen) — de flip is klein omdat het
leespad bewezen compatibel is.
**Compute:** een drie-lagenmodel naar industriepatroon (MotherDuck/ClickHouse: goedkope
gedeelde serving + geïsoleerde zware compute): (L1) interactief blijft in de backend maar
krijgt timeouts, caps en later een child-proces-runnerpool; (L2) alle BullMQ-batchwerk
verhuist naar een aparte worker-app; (L3) syncs blijven ACA Jobs.

Waarom níet de alternatieven:
- **ACA Job per query** — 30–60s cold start maakt C1/C2/C3 onbruikbaar; wel het juiste
  model voor C6 en (later, optioneel) extreem zware transformaties.
- **Per-tenant compute-apps (MotherDuck-model)** — sterkste isolatie maar honderden
  scale-to-zero-apps beheren is ops- en kosten-overkill op onze schaal; dit is het
  groeipad ná product-market-fit op honderden tenants, niet ervoor.
- **Alles naar een externe engine (managed ClickHouse/Snowflake)** — vernietigt onze
  kostenstructuur (het competitieve voordeel uit de analyse) en lost isolatie alsnog niet
  op zonder hetzelfde werk.

---

## 3. Spoor A — storage: per-tenant containers activeren

### A0. Pre-flip fixes (klein, geen gedragsverandering)
1. **Containernaam-validatie** in `warehouseContainer()`: prefix+id → 3–63 chars,
   `[a-z0-9-]`; faal luid vóór `createIfNotExists`.
2. **`productContext.getProductWarehousePath`** retourneert in per-tenant mode nog de
   shared root (`warehouseRoot()` zonder tenantId, `productContext.ts:362`). Vandaag
   alleen een cache-key, maar het is de laatste latente shared-container-aanname —
   tenant-aware maken.
3. **Tests**: per-tenant-branch van `accountDeletion` (mock), SAS-container-selectie
   (unit op `BlobSasTokenIssuer`-args), paden al gedekt door `paths.test.ts`.

### A1. Validatie (het S10-gat pragmatisch oplossen)
Er is geen aparte staging-infra. Twee opties:

- **(a) Gekozen aanbeveling — validatie op de 0%-traffic staging-revisie met een
  test-tenant, tegen het prod-storage-account.** Argument: de flip is *additief en
  omkeerbaar* — hij verandert alleen waar NIEUWE writes landen; bestaande URIs blijven in
  beide richtingen geldig (S2 is geverifieerd), en flag terug = nieuwe writes weer shared.
  Een nieuwe ACA-revisie kan eigen env-waarden krijgen (`WAREHOUSE_CONTAINER_MODE=per-tenant`)
  op 0% traffic; via de vaste staging-URL met een wegwerp-testtenant valideren we de hele
  keten. Risico beperkt tot: extra containers in prod-account (opruimbaar), en de
  testtenant zelf.
- **(b) Volwaardige staging-omgeving in Terraform** (eigen resource group, storage,
  Postgres). Structureel de juiste investering voor een "professioneel platform", maar
  een apart project (kosten ~€30+/mnd, migratie-/seed-strategie) — niet op het kritieke
  pad van deze flip. → apart beslispunt.

**Validatie-checklist (testtenant, staging-revisie):**
sync nieuwe connectie → container `tenant-<id>` aangemaakt (race: 2 syncs tegelijk),
worker schrijft onder `conn_<cid>/` in de juiste container, SAS getest op cross-container
write (moet 403 geven), `warehouse_path` per-tenant-URI persist, dashboards/Ask-AI lezen
zowel nieuwe als legacy-shared data, transformatie draait (⚠️ **Delta-sidecar**: container
moet pre-existen — `ensureWarehouseContainer` draait vóór productwrites, expliciet
verifiëren), rollups (parquet-pad), offboarding: `purgeTenant` → container weg.

### A2. De flip
- Terraform: `variables.tf` default `warehouse_container_mode = "per-tenant"` (+
  `lifecycle`-check dat de env doorkomt), deploy, eerste echte syncs monitoren.
- Runbook-notitie: gemengde staat is normaal en ontworpen — oude data shared, nieuwe
  per-tenant; het account-level DuckDB-secret leest beide.

### A3. Legacy-migratie (S9)
- **Primair: incrementeel** (bestaand gedocumenteerd model): elke re-sync verhuist
  source-data, elke product-refresh verhuist productdata. Ops-runbook: per tenant één
  keer "volledige re-sync + rebuild" triggeren (kan gespreid), daarna oude
  `tenant_<id>/`-prefix in de shared container verwijderen.
- **Backfill-script** (optioneel, alleen als re-syncs voor een bron pijnlijk zijn):
  walk `connections`/`product_tables`-rijen met shared-URIs → server-side blob-copy →
  URI-update. Klein, maar pas schrijven als er vraag is.
- **Prefix-scoped delegation SAS voor legacy-data: NIET doen als primair pad.**
  Bevinding uit de audit: `@azure/storage-blob` (gepind ^12.31.0) kan geen
  directory-SAS (`sr=d`/`sdd`) genereren — dat vereist `@azure/storage-file-datalake`
  erbij. Een extra SDK + tweede SAS-model introduceren voor data die toch wegmigreert is
  complexiteit op de verkeerde plek. Alleen heroverwegen als legacy-data lang blijft.

### A4. Auth-ontvlechting (S5 — structureel, na de flip)
Audit-bevinding: containercreatie, DuckDB-secret én Python-sidecar draaien allemaal op de
account-key uit `AZURE_STORAGE_CONNECTION_STRING`; niets gebruikt `DefaultAzureCredential`.
Gevolg: (1) shared-key uitzetten (gepland hardening-item) breekt vandaag drie dingen
tegelijk; (2) product-transform-compute kan elke container bereiken, wat de
per-container-isolatie aan de compute-kant deels tenietdoet.
- Stap 1: containercreatie op managed identity (`Storage Blob Data Contributor` is er al).
- Stap 2 (samen met Spoor B L2): transformaties draaien in de worker-app met een
  **per-tenant-container SAS** i.p.v. de account-key — dan geldt de fysieke grens ook
  voor productwrites. Sidecar accepteert `storage_options`; die vanuit Node meegeven
  i.p.v. de sidecar zelf de connection string laten parsen.
- Stap 3: `shared_access_key_enabled=false` zodra de Neo4j-file-share ontvlochten is.

---

## 3bis. KRITIEK — compute-security-isolatie (nieuwe bevinding 2026-07-23)

Een aparte security-audit van de query-executiepaden legde bloot dat compute vandaag
**niet security-geïsoleerd is tussen tenants** — dit is ernstiger dan het
performance-verhaal en verschuift de prioriteit. Kern:

- **De DuckDB-sessies zijn niet gesandboxed en dragen een account-breed storage-secret.**
  `setupDuckDBForWarehouse`/`applyResourceGuardrails` (`duckdb.ts:26-156`) zetten alleen
  resource-settings; nergens `SET enable_external_access=false`, `allowed_paths`,
  `disabled_filesystems` of `lock_configuration=true` (repo-brede grep = 0 hits). Het
  secret komt uit `AZURE_STORAGE_CONNECTION_STRING` → toegang tot het **hele** account,
  dus elke tenant-prefix.
- **De enige SQL-guard (`sqlGuard.ts`) blokkeert alleen niet-SELECT-keywords, geen
  table-functions of pad-literals.** `read_parquet`, `delta_scan`, `read_text`,
  `read_csv`, `glob`, `COPY` binnen een SELECT staan niet op de FORBIDDEN-lijst. Dus
  `SELECT * FROM read_parquet('az://warehouse/tenant_<ANDER>/...')` passeert de guard.
- **Reikwijdte per surface (verdict uit de audit):**
  - **Notebooks** (`routes/notebooks.ts:132,764`): **geen guard, willekeurige SQL** —
    lezen én schrijven van elke tenant-blob, `read_text('/proc/self/environ')` (dumpt de
    connection string zelf → volledige account-escalatie), `COPY TO 'az://...'`. Zwaarste
    surface.
  - **Dashboards** (`routes/dashboards.ts:522-630`): widget-SQL komt **rauw uit de
    request body**, geen SELECT-only-guard, geen her-validatie tegen de opgeslagen spec —
    lezen én schrijven, zelfde reik als notebooks.
  - **Ask-AI** (`routes/query.ts`): SELECT-only afgedwongen (schrijven geblokkeerd), maar
    een gestuurd/prompt-geïnjecteerd `read_parquet('az://...ander...')` passeert de guard
    en leest cross-tenant.
  - **Transformaties**: `CREATE TABLE AS ${sql}` met account-secret, geen guard
    (moet schrijven) — zelfde reik server-side.
- **Wat vandaag WEL houdt:** Postgres-RLS bepaalt welke `connectionId`/`productId` een
  gebruiker mag benoemen (dus je kunt de connector niet op andermans warehouse richten) —
  maar dat sluit de in-SQL `read_parquet('az://...')`-vector niet, want die omzeilt de
  connector/catalog volledig.
- **Marktcontext:** DuckDB's eigen docs zeggen expliciet dat deze settings
  *defense-in-depth* zijn en "geen vervanging voor echte sandboxing" bij untrusted SQL —
  een gedeeld proces met meerdere tenants' SQL is geen security-grens. De citeerbare
  precedenten dat cross-tenant-lekken juist via de gedeelde compute-laag gebeuren zijn
  **ChaosDB** (Azure Cosmos DB, 2021 — via de gedeelde notebook-compute) en **SynLapse**
  (Azure Synapse, CVE-2022-29972 — gedeelde integration runtime); Microsoft's fix in
  beide gevallen was per-executie compute-isolatie.

**Mitigaties (P0 — vóór de rest):**
1. **DuckDB-lockdown op elke sessie:** `SET enable_external_access=false` waar mogelijk;
   waar externe blob-reads nodig zijn (dat is het normale pad) `allowed_paths`/
   `allowed_directories` scopen op de **eigen tenant-prefix/-container** +
   `lock_configuration=true` als sluitstuk. Dit maakt padliteralen naar andere tenants
   fysiek onbereikbaar, zelfs met account-secret.
2. **Per-tenant-scoped storage-secret i.p.v. account-connection-string:** de DuckDB-sessie
   krijgt een SAS gescoped op de tenant-container (bestaande `BlobSasTokenIssuer`) i.p.v.
   `AZURE_STORAGE_CONNECTION_STRING`. Sluit A4 (auth-ontvlechting) en dit samen.
3. **SQL-guard uitbreiden:** table-functions + pad-literals (`read_*`, `delta_scan`,
   `glob`, `az://`, absolute paden) op een deny-lijst; SELECT-only ook op notebooks en
   dashboards afdwingen; dashboard-widget-SQL her-valideren tegen de opgeslagen spec i.p.v.
   rauw uit de request uitvoeren.
4. **Per-tenant containers (Spoor A)** maken lockdown+SAS pas echt hard: dan is er
   überhaupt geen ander tenant-pad in dezelfde container te benoemen.

**Belangrijk kader:** onze audit maakt aannemelijk dat Peliqan's compute-isolatie
(gedeeld Trino + gedeeld Postgres, logische DB per workspace, soft limits) **niet sterker**
is dan de onze — hun echte voorsprong is certificering (SOC 2/ISO 27001), niet harde
compute-isolatie. Dat betekent niet dat wij dit mogen laten liggen: security-isolatie is op
elk prijsniveau een must-have (een lek is onvergeeflijk), en de sandbox-mitigaties hierboven
zijn goedkoop en brengen ons meteen op norm.

---

## 4. Spoor B — compute: drie lagen

### Laag 1 — interactieve serving (C1/C2/C3/C5-licht) blijft in de backend, gehard

**Argument om in-process te blijven:** latency-eis I5 — warme DuckDBPool-views,
widgetCache en rollups geven sub-seconde widgets; elke uit-proces-hop (job, aparte app)
voegt seconden toe aan het meest gevoelige pad. Het industriepatroon is niet "alles
isoleren" maar "goedkoop gedeeld serveren, zwaar werk isoleren".

**B1.1 — Timeout + concurrency (quick wins, dagen werk, dekt het acuutste risico):**
- `executeQuery` krijgt een per-query timeout (default 30s interactief, env-instelbaar;
  DuckDB `interrupt()` waar de binding het ondersteunt, anders sessie sluiten).
- **Globale semaphore** per replica (bv. max 4 concurrente DuckDB-queries) +
  **per-tenant cap** (bv. 2) — lost I4 op; `batch-execute` van `Promise.all` naar
  `p-limit` (bv. 3 tegelijk).
- `aiLimiter`-achtige rate limits ook op `/dashboards`, `/notebooks`, `/quality`
  (nu alleen de globale 200/min).
- **DuckDBPool cap** (LRU, bv. max 8 instanties) + `DUCKDB_MEMORY_LIMIT` afgestemd op
  poolgrootte i.p.v. 70% per instantie (I2).
- Quality-profiling (nu synchroon in de HTTP-handler) → naar de queue.
- Export-XLSX: rijen-cap + streaming, of naar Laag 2 als job met notificatie.

**B1.2 — Query-runnerpool (structurele fix voor I1/I3, na B2):**
- Klein pool (2–3) **child-processen** in de backend-container die de DuckDB-executie
  doen; parent stuurt SQL + view-registraties via IPC, krijgt rijen terug.
- Timeout ⇒ `SIGKILL` child + respawn — harde cancel die in-process onmogelijk is;
  segfault kost één runner, niet de API; per-proces `memory_limit` maakt het
  geheugenbudget optelbaar.
- Argument: dit is exact het bestaande `LocalProcessJobLauncher`-patroon; de
  serialisatiekost is verwaarloosbaar (rijen gaan vandaag ook al als JSON naar de client)
  en de pool blijft warm dus latency blijft interactief.

**B1.3 — Sizing:** backend naar **1 vCPU / 2 GiB** en **`min_replicas=1`** in prod.
Argument: 1 GiB is de krapste analytical-serving-laag in het hele vergelijkingsveld, en
scale-from-zero geeft business-users cold starts. Kosten: ~€20–35/mnd extra (beslispunt).

### Laag 2 — batchwerk (C4/C5-zwaar) naar een aparte worker-app

**Kernfeit uit de audit:** `startWorkers()` draait in `app.listen` — álle BullMQ-workers
(transformation, bus-matrix, schema-profiling, email-report, morning-brief, maintenance,
schedulers) leven in het API-proces. Eén transformatie van tenant A vreet het geheugen op
waarmee tenant B's dashboard bediend wordt.

**B2.1 — `ROLE`-flag in het backend-image:** `ROLE=api` (Express, géén workers) /
`ROLE=worker` (alleen `startWorkers()`, geen ingress) / default beide (lokaal/dev
ongewijzigd). Eén image, geen aparte build — het backend-image bevat DuckDB en alle
warehouse-code al.

**B2.2 — Nieuwe ACA-app `jobs-worker`:** intern, geen ingress, **1 vCPU / 2 GiB**
(transformaties zijn de zwaarste werklast), **KEDA-scaling op Redis-queue-lengte,
min 0 / max 2** — scale-to-zero behouden (I7): geen jobs = geen kosten; queue vult zich =
worker start (~15–30s, acceptabel voor batch).

**B2.3 — Randvoorwaarden (dit is het echte werk):**
- **Redis-persistentie aan** (AOF) — anders verdwijnen geplande jobs bij restart (I9).
- **Events & cancellation cross-proces**: SSE-progress (bus-matrix/pipelines) en de
  cancellation-registry zijn nu in-memory in het API-proces. Naar Redis pub/sub
  (de code markeert dit zelf al als de multi-replica-fix). Zonder deze stap breekt de
  live build-log zodra workers verhuizen — dít is de kritieke afhankelijkheid.
- Inline-fallback (geen Redis) blijft bestaan voor local dev.
- **Per-tenant SAS voor transform-writes** (koppelt aan A4 stap 2): de worker-app vraagt
  per job een container-SAS bij de bestaande `BlobSasTokenIssuer` i.p.v. de account-key
  te gebruiken → fysieke tenantgrens geldt dan ook voor productdata.
- BullMQ-concurrency per queue blijft de batch-fairness-knop; + per-tenant "max 1 zware
  job tegelijk" in de orchestrator.

### Laag 3 — bestaand + groeipad
- Syncs: ACA Jobs, ongewijzigd (al goed).
- **Groeipad** (pas relevant ruim voorbij honderden tenants of bij een enterprise-tier):
  extreem zware transformaties als ACA Job per run (het sync-patroon hergebruiken);
  per-tenant worker-apps of deployment stamps; premium-tier met encryption scope/CMK
  per tenant en evt. dedicated storage account. Bewust NIET nu — kosten/ops zonder
  aantoonbare vraag.

### Observability (I8, dwars door alles)
Per query: tenant, duur, rijen, bytes gescand (DuckDB-profiling), uitkomst
(ok/timeout/killed) → App Insights. Per-tenant compute-dashboards zijn ook de basis voor
S7 (kostenattributie) en latere fair-use-limieten per prijsplan.

---

## 5. Fasering, effort, afhankelijkheden

| Fase | Inhoud | Effort | Dekt | Afhankelijkheid |
|---|---|---|---|---|
| **P0** | §3bis security-lockdown: DuckDB `enable_external_access`/`allowed_paths`/`lock_configuration` op elke sessie, per-tenant-scoped SAS-secret i.p.v. account-string, SQL-guard uitbreiden (table-functions/pad-literals + SELECT-only op notebooks/dashboards + widget-SQL her-valideren) | dagen | **cross-tenant datalek (lezen+schrijven)** — hoogste prioriteit | geen |
| **0** | B1.1 quick wins: timeouts, semaphores, p-limit, rate limits, pool-cap, quality→queue, export-cap + A0 pre-flip fixes | dagen | I2 I3 I4 (runaway query = API down) | geen (samen met P0) |
| **1** | Spoor A: validatie-checklist op staging-revisie → flip default → runbook | dagen (validatie is het meeste werk) | S1 S3 (+ maakt P0-lockdown hard) | A0 |
| **2** | Spoor B L2: ROLE-flag, jobs-worker-app, Redis-AOF, events/cancellation via Redis, KEDA, terraform | 1–2 weken | I1(batch) I6 I9, halve S5 | Fase 0 |
| **3** | B1.2 runnerpool interactief + B1.3 sizing | ~1 week | I1(interactief) I3 hard (proces-per-executie = ook security-diepteverdediging) | Fase 2 (leert ons de patronen) |
| **4** | A3 legacy-migratie afronden + A4 auth-ontvlechting + shared key uit | dagen–week | S5 S9 | Fase 1+2 |
| later | Groeipad L3, premium-tier, staging-omgeving als infra | — | — | vraag-gedreven |

Volgorde-argument: **P0 gaat vóór alles** — het is de enige zwakte die een echt
cross-tenant datalek toelaat (notebooks/dashboards kunnen vandaag andermans blobs lezen
én schrijven), kost slechts dagen, en is onafhankelijk van de rest. Fase 0 loopt parallel
(dempt het runaway-query-scenario). Fase 1 sluit aan omdat per-tenant containers de
P0-lockdown pas fysiek hard maken. Fase 2 vóór Fase 3: zodra batch weg is uit het
API-proces is de resterende interactieve werklast klein en voorspelbaar, wat de
runnerpool-dimensionering eenvoudig maakt; die runnerpool geeft bovendien proces-per-executie,
de door DuckDB's eigen docs aanbevolen echte sandbox-grens.

---

## 6. Beslispunten voor de eigenaar

1. **Kosten**: dit plan verhoogt de idle-kost bewust: backend min 1 replica + 2 GiB,
   worker-app (scale-to-zero, dus vooral bij gebruik), Redis-persistentie. Schatting:
   van ~€30–60/mnd naar ~€60–100/mnd. Akkoord?
2. **Validatie-aanpak flip**: testtenant op de 0%-traffic staging-revisie tegen het
   prod-storage-account (aanbevolen, snel, omkeerbaar) — of eerst een volwaardige
   staging-omgeving bouwen (structureel beter, apart project, +€30+/mnd)?
3. **Legacy-data**: incrementeel via geplande re-syncs per tenant (aanbevolen) of direct
   een backfill-script?
4. **Startmoment**: na akkoord kan Fase 0 + A0 meteen; de flip zelf (Fase 1) pas na de
   validatie-run.

## 7. Risico's & mitigaties

| Risico | Mitigatie |
|---|---|
| Sidecar faalt op niet-bestaande container | `ensureWarehouseContainer` vóór productwrites (bestaat); expliciet in validatie-checklist |
| SSE-buildlogs breken bij worker-split | Redis pub/sub events **vóór** de split shippen (Fase 2 randvoorwaarde) |
| Timeout killt legitieme lange query | timeouts per surface configureerbaar (interactief kort, notebooks/exports langer); telemetrie eerst, dan aanscherpen |
| Twee replicas maken dubbele containers | `createIfNotExists` is idempotent; race is onschadelijk |
| Flip breekt een over het hoofd gezien leespad | audit vond er nul; flag-terugdraai is onmiddellijk en verliesloos (URIs blijven geldig) |
| Redis-AOF vult disk | kleine AOF (queues zijn klein), `maxmemory`-policy zetten |
