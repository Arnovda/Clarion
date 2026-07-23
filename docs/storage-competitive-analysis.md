# Clarion opslag- & compute-analyse vs. vergelijkbare KMO-dataplatformen

**Datum:** 2026-07-23
**Aanleiding:** vraag van de eigenaar: "Wij gebruiken nu 1 storage account met 1 container
per klant denk ik. Wat doen andere vergelijkbare platformen zoals Peliqan? Zijn wij het
juiste aan het doen, met oog op een professioneel platform dat robuust is voor honderden
klanten?"
**Methode:** codebase-audit (Terraform + backend) + webonderzoek naar Peliqan, 10+
vergelijkbare platformen, en officiële Microsoft multi-tenant-richtlijnen. Bronnen per
sectie; onzekere claims zijn gemarkeerd.

---

## 1. Wat Clarion vandaag werkelijk doet (correctie op de aanname)

De aanname "1 container per klant" klopt **niet** voor productie. De feitelijke situatie:

| Laag | Realiteit vandaag |
|---|---|
| Storage accounts | **Eén** account voor het hele platform (`azurerm_storage_account.warehouse`, `infra/main.tf:173-201`), Standard/GRS, West-Europa, TLS 1.2, soft-delete 30d + versioning aan. |
| Containers | Drie: `warehouse` (alle klantdata), `sync-heartbeat`, plus een `neo4j-data` file share. |
| Tenant-isolatie op blob-niveau | **Shared container met padprefix** `tenant_<id>/…` — afgedwongen in applicatiecode, niet door Azure. `WAREHOUSE_CONTAINER_MODE` default = `shared` (`infra/variables.tf:107-115`). |
| Per-tenant containers | **Gebouwd maar default-uit** (opt-in `per-tenant` mode, 2026-07-11); nog niet gevalideerd in staging. |
| SAS voor sync-workers | **User-delegation SAS** (managed identity, geen account key — goed), maar **container-breed** gescoped: in shared mode kan een worker-token fysiek bij elke tenant; padconfinement zit alleen in workercode (`BlobSasTokenIssuer.ts:99-114`). |
| Formaten | Bronnen: Parquet. Producttabellen: Delta Lake (default) via Python-sidecar, Parquet als opt-out. |
| Compute | DuckDB **in-process in de backend-container** (0.5 vCPU / 1 GiB, 0-3 replicas) voor alle tenants. Guardrails sinds 2026-07-11: `memory_limit 70%`, `threads 2`, spill-to-disk, 100k-rijenlimiet. Syncs draaien wél geïsoleerd als ACA Jobs (0.5 vCPU / 1 GiB, 30 min cap). |
| Metadata | Postgres Flexible Server **B1ms burstable** (32 GB), Neo4j scale-to-zero, Redis zonder persistentie. |

Samengevat: metadata-isolatie is hard (RLS op 63 tabellen, security-audit 2026-05-14),
maar **warehouse-isolatie is vandaag zacht** (padprefix + code), en alle query-compute
deelt één klein proces.

---

## 2. Peliqan — het referentiepunt

Belgisch (Gent, 2022), oprichter Niko Nelissen (ex-Blendr.io → Qlik). Positionering
verschoven naar "the trust layer for AI & BI".

- **Aanbod:** 250-300+ connectors (Singer-taps), ingebouwd warehouse, SQL-editor,
  low-code Python, spreadsheet-UI + Streamlit-apps (BI is dun; Metabase-partner),
  reverse ETL, MCP-server/AI-governance, white-label warehouse per eindklant voor
  SaaS-bedrijven/accountants.
- **Warehouse-technologie:** ingebouwd warehouse op **PostgreSQL**, met **Trino** als
  federatie-/query-engine (docs: "built-in data warehouse (Postgres)"). BYO-optie:
  Snowflake, BigQuery, Redshift, SQL Server. ("Columnar"-claim in marketing is
  onverklaard.)
- **Isolatie:** "dedicated warehouse per klant" is een marketingpijler — gezien de
  Postgres-basis vrijwel zeker een **aparte database/schema per tenant**, geen aparte
  infrastructuur; hun eigen blog noemt het een "multi-tenant deployment model".
- **Hosting:** **AWS Frankfurt (eu-central-1)**, EU-only, Belgische entiteit —
  actief uitgespeeld als GDPR/CLOUD-Act-argument. Micro-services op Kubernetes;
  optionele private-cloud-deployment via Kubernetes.
- **Certificering:** SOC 2 Type II + ISO 27001.
- **Prijs:** Starter €350/m (2 users, ~5M rijen fair use), Pro €500/m, Enterprise
  vanaf €1.500/m. Geen gratis tier.
- **Schaal:** geen publieke klantaantallen; derden schatten ~$2,9M ARR / ~26 medewerkers
  (onzeker).
- **Gaten t.o.v. Clarion:** geen AI-gegenereerde sterschema's, geen semantische
  profilering met vendor-docs-provenance, geen AI-dashboardgenerator van onze diepte.

---

## 3. Het landschap (10+ platformen, samengevat)

Twee architectuurkampen:

**Kamp A — warehouse-resellers** (verkopen Snowflake/BigQuery-economie door):
- **Mozart Data** (US): Fivetran + managed Snowflake/BigQuery in vendor-account; vanaf ~$1.000/m.
- **5X** (SG/US): orkestreert best-of-breed; Snowflake via 5X of BYO; usage-based.
- **Weld** (DK): ELT + SQL, primair BYO-warehouse; gratis Weld-managed BigQuery
  (Weld-owned GCP-project) als instap; vanaf ~$99/m.
- **Y42** (DE): strikt BYO Snowflake/BigQuery; alleen control plane.
- **Keboola** (CZ): platform-storage op Snowflake/BigQuery die Keboola beheert; stacks op
  AWS/Azure/GCP EU; ook BYODB en single-tenant in klant-cloud; $0,14/compute-minuut.

**Kamp B — eigen engine** (bezitten opslag + compute zelf):
- **Peliqan** (BE): Postgres + Trino, AWS Frankfurt (zie §2).
- **Definite** (US): het dichtst bij Clarion's architectuur — **DuckDB + DuckLake:
  Parquet op Google Cloud Storage, Postgres-catalogus, DuckDB als engine**; per-tenant
  catalogi/GCS-prefixes + gescopede IAM/HMAC; native BI + Cube-semantische laag + AI-analist;
  $250/m unlimited. Publiek bewijs dat DuckDB+Parquet-op-objectstorage commercieel werkt.
- **MotherDuck** (US): pure serverless-DuckDB-infra (geen connectors/BI); "differential
  storage" op S3, **per-user geïsoleerde DuckDB-instanties ("ducklings")**; AWS incl.
  Frankfurt/Dublin; Business $250/m + usage.
- **Dataddo** (CZ): connectors + lichte "SmartCache"-opslag, vanaf $99/m.
- Adjacent: **Holistics** (BI op BYO-warehouse, slaat zelf niets op), **Fabi.ai**
  (AI-analist zonder warehouse), **Rivery→Boomi** (uit het segment gedreven),
  **Whaly** (gepivoteerd weg van BI — waarschuwend voorbeeld).

**Belangrijke marktobservaties:**
1. Niemand in dit segment doet storage-account-per-tenant; vendor-owned storage met
   logische isolatie is de norm. Per-tenant *containers* (ons gebouwde model) is zelfs
   **sterker** dan wat ClickHouse Cloud (subpath in gedeelde bucket) en Tinybird
   (query-layer-isolatie) doen.
2. Prijsbanden: eigen-engine-platformen (€99-350/m instap) onderbieden resellers
   (~$800-1.000+/m) met factor 3-5 omdat ze geen Snowflake-marge doorrekenen. Onze
   DuckDB-kostenstructuur (~$0,75-2/m AI-kost per tenant + goedkope blob-storage) zit
   aan de goede kant.
3. EU-hosting is een echt onderscheidend argument: alleen Peliqan (AWS Frankfurt),
   Keboola (EU-stacks) en MotherDuck (Frankfurt/Dublin) adverteren het. Definite lijkt
   US-only. Clarion op Azure West-Europa kan dezelfde claim maken.
4. AI-gegenereerde sterschema's + vendor-docs-gedreven semantiek heeft **niemand** —
   de AI-features elders zijn SQL-copilots of handmatige semantische lagen.

---

## 4. Wat Microsoft en de industrie voorschrijven (multi-tenant storage op Azure)

Officiële limieten (Microsoft docs, geverifieerd):
- Containers per storage account: **onbeperkt**. Account-capaciteit: 5 PiB.
  Request rate: 20.000 req/s per account. Accounts per regio/subscription: 250 (500 op
  aanvraag).
- Honderden KMO-tenants à 1-50 GB = ≤ ~25 TB en ver onder de request-rate-limieten;
  DuckDB doet grote sequentiële range-reads, wat throughput-vriendelijk is.
  **Eén storage account volstaat ruim voor honderden klanten.**

Microsoft's multi-tenant-modellen (Azure Architecture Center):
1. **Account per tenant** — alleen voor high-compliance klanten (eigen keys, eigen
   geo); begrensd door quota en beheerslast. Niet het default-model op schaal.
2. **Container per tenant** — het aanbevolen middenmodel; expliciet "meer schaalbaar
   want containers zijn onbeperkt". Offboarding = één `Delete Container` (GDPR-wissing
   auditbaar en compleet).
3. **Shared container met tenant-id in het pad** — het zwakste model; Microsoft
   benoemt expliciet dat isolatie dan volledig van applicatiecode afhangt.
   **Dit is wat Clarion-productie vandaag draait.**

Relevante nieuwe optie: **prefix-scoped user-delegation SAS is GA sinds april/mei 2026**
(`sr=d` + `sdd`, werkt op flat namespace, geen ADLS Gen2 nodig) — daarmee kan zelfs de
shared container een cryptografische per-tenant-grens krijgen zonder blobs te verplaatsen.
Handig voor legacy-data tijdens/na de migratie naar per-tenant containers.

Encryption scopes per container (tot 10.000 CMK-scopes/account, wel per scope
gefactureerd) en cross-tenant CMK zijn de bouwstenen voor een latere premium/compliance-tier
zonder dedicated accounts.

Wat de grote spelers doen: Snowflake, ClickHouse Cloud, Tinybird en MotherDuck slaan
allemaal klantdata op in **vendor-owned object storage met logische isolatie**; alleen
Databricks (classic) legt data in de bucket van de klant. Harde key-isolatie (CMEK) is
overal een premium-tier, nergens de default.

---

## 5. Beoordeling: doen we het juiste?

### Wat goed zit (niet aan sleutelen)

1. **De fundamentele architectuurkeuze — DuckDB + Parquet/Delta op vendor-owned object
   storage — is juist** en wordt commercieel gevalideerd door Definite (zelfde stack op
   GCP) en MotherDuck ($100M funding op precies deze these). Het geeft ons de
   kostenstructuur om Peliqan's €350/m-instap te onderbieden, en open formaten
   (Parquet/Delta) zijn een eerlijk anti-lock-in-verhaal.
2. **Azure is geen nadeel.** Peliqan's AWS-Frankfurt-verhaal is een *EU-residency*-verhaal,
   geen AWS-verhaal. Azure West-Europa + (t.z.t.) een Belgische entiteit levert exact
   dezelfde claim. Keboola bewijst dat Azure-EU-stacks in dit segment normaal zijn.
   Migreren naar AWS zou kosten en risico toevoegen zonder enig competitief voordeel.
   Niemand in het veld is "self-hosted"; Kubernetes-private-cloud (Peliqan, Keboola
   single-tenant) is een enterprise-optie, geen KMO-noodzaak.
3. **Eén storage account** is bij honderden KMO-tenants ruim binnen het ontwerpvenster
   van Microsoft. Account-per-tenant zou onnodige beheerslast zijn; niemand doet het.
4. **Sync-compute is al goed geïsoleerd** (ephemeral ACA Jobs per sync, 90-min
   user-delegation SAS, write/create-only, egress-allowlists).
5. **Metadata-isolatie** (RLS + FORCE RLS op alle 63 tenant-tabellen) is sterk.

### Waar we achterlopen op onze eigen lat (de echte gaten)

1. **Productie draait het zwakste isolatiemodel terwijl het betere al gebouwd is.**
   Shared container + padprefix is Microsoft's expliciet zwakste model; de worker-SAS is
   container-breed, dus één bug in workercode kan cross-tenant schrijven. De oplossing
   (`WAREHOUSE_CONTAINER_MODE=per-tenant`) ligt sinds 2026-07-11 op de plank, default-uit
   en ongevalideerd. **Actie: valideren in staging en default maken.** Daarmee zitten we
   meteen *boven* de industrienorm (ClickHouse Cloud/Tinybird doen slechts subpaths).
   Bestaande data blijft leesbaar (absolute URI's); legacy-shared-data kan desgewenst
   extra beveiligd worden met de nieuwe prefix-scoped delegation SAS i.p.v. migratie.
2. **Compute is het grotere multi-tenant-risico, niet storage.** Alle dashboards, NL→SQL
   en transformaties van álle tenants delen één DuckDB in één 0.5 vCPU / 1 GiB
   backend-proces. De guardrails begrenzen schade maar bieden geen fairness (noisy
   neighbor) en geen crash-isolatie (een segfault op een corrupt parquet-bestand haalt
   de API voor iedereen neer). Industriepatroon (MotherDuck ducklings, ClickHouse
   per-tenant-pods): **goedkope gedeelde serving voor lichte interactieve queries +
   geïsoleerde compute voor zwaar werk**. Wij hebben de machinerie al (BullMQ + ACA
   Jobs): route transformaties/Analyse/exports/lange queries door een worker-proces
   buiten de API-container. Verhoog daarnaast de backend-sizing (1 GiB is krap voor een
   analytische engine) en overweeg min_replicas=1 voor productie.
3. **Robuustheidsrandjes voor "honderden klanten"** buiten de warehouse zelf:
   Postgres B1ms burstable (metadata + RLS-kritisch), Redis zonder persistentie
   (geplande jobs weg bij restart), Neo4j scale-to-zero (cold starts), en
   `shared_access_key_enabled` nog aan op het storage account (nodig voor de Neo4j file
   share — ontvlechten). Geen blockers, wel opschaal-items.
4. **Compliance-verkoopkant:** Peliqan wint deals op SOC 2 + ISO 27001 + EU-verhaal,
   niet op techniek. Per-tenant containers, één-klik-offboarding en encryption-scope-
   per-tenant zijn precies de bouwstenen die zo'n certificeringstraject en
   security-questionnaires goedkoop maken. Per-tenant kostenattributie (blob-metrics
   zijn account-level) wordt dan ook nodig voor unit-economics per klant.

### Aanbevolen volgorde

| # | Actie | Effort | Waarom nu |
|---|---|---|---|
| 1 | `WAREHOUSE_CONTAINER_MODE=per-tenant` valideren in staging → default in prod | Klein (gebouwd) | Sluit het cross-tenant-schrijfrisico; maakt GDPR-offboarding één operatie; boven industrienorm |
| 2 | Zware queries (transformaties, Analyse, exports) uit de API-container naar job-workers | Middel (machinerie bestaat) | Grootste stabiliteitsrisico bij groei; industriepatroon |
| 3 | Backend-sizing omhoog (≥2 GiB, min 1 replica prod) + DuckDB-guardrails hertunen | Klein | 1 GiB is de krapste analytical-serving-laag in het hele vergelijkingsveld |
| 4 | Prefix-scoped user-delegation SAS voor legacy shared-container data | Klein | GA sinds april 2026; hardt oude data zonder migratie |
| 5 | Redis-persistentie aan, Postgres-SKU-pad plannen, storage-account shared key ontvlechten | Klein-middel | Robuustheid op honderden tenants |
| 6 | Later: encryption scope per tenant / dedicated account + CMK als premium-tier; pool-of-accounts als sharding-escape-hatch (pas relevant ruim voorbij honderden tenants) | Gepland, niet nu | Microsoft's eigen opschaalpad |

### Eindoordeel

De storage-*keuzes* (Azure, vendor-owned blob, Parquet/Delta, DuckDB, één account) zijn
juist en marktconform tot marktleidend qua kostenstructuur. Wat ontbreekt is geen andere
architectuur maar het **activeren en valideren van de isolatie die al gebouwd is**
(per-tenant containers) en het **loskoppelen van zware compute van de API** — dat zijn de
twee dingen die het verschil maken tussen "werkt voor tientallen klanten" en "robuust
voor honderden".

---

## Bronnen (selectie)

- Microsoft: [Multitenancy and Azure Storage](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/storage) · [Storage/data approaches](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/storage-data) · [Scalability targets](https://learn.microsoft.com/en-us/azure/storage/common/scalability-targets-standard-account) · [Prefix-scoped SAS GA](https://techcommunity.microsoft.com/blog/azurestorageblog/prefix-scoped-access-for-user-delegation-sas-is-now-generally-available-for-azur/4516010) · [Encryption scopes](https://learn.microsoft.com/en-us/azure/storage/blobs/encryption-scope-overview)
- Peliqan: [pricing](https://peliqan.io/pricing/) · [platform](https://peliqan.io/platform/) · [architecture (help)](https://help.peliqan.io/feature-list-roadmap-and-architecture) · [GDPR/MCP-blog](https://peliqan.io/blog/gdpr-compliant-mcp-servers/) · [white-label DWH](https://peliqan.io/white-label-data-warehouse-for-saas-companies/)
- Definite: [platform](https://www.definite.app/platform) · [DuckLake-businesscase](https://www.definite.app/blog/duckdb-ducklake-business-case)
- MotherDuck: [architecture](https://motherduck.com/docs/concepts/architecture-and-capabilities/) · [Differential Storage](https://motherduck.com/blog/differential-storage-building-block-for-data-warehouse/)
- ClickHouse Cloud: [architecture](https://clickhouse.com/docs/cloud/reference/architecture) · Tinybird: [architecture-blog](https://www.tinybird.co/blog/tinybird-architecture) · Snowflake: [key concepts](https://docs.snowflake.com/en/user-guide/intro-key-concepts)
- Keboola: [FAQs](https://www.keboola.com/faqs) · [BYODB](https://help.keboola.com/storage/backends/byodb/) · Weld: [managed BigQuery](https://weld.app/docs/destinations/weld-managed-bigquery) · Mozart Data: [warehouse solution](https://mozartdata.com/data-warehouse-solution/) · 5X: [pricing](https://www.5x.co/pricing) · Y42: [warehouse docs](https://www.y42.com/docs/integrations/data-warehouse)
