# Runbook: per-tenant warehouse containers activeren (Fase 1)

**Doel:** `WAREHOUSE_CONTAINER_MODE` van `shared` (padprefix-isolatie in code) naar
`per-tenant` (één Azure Blob-container per tenant = harde storage-grens + één-klik
offboarding).
**Status:** code-klaar. De daadwerkelijke flip is een bewuste ops-actie (vereist
`terraform`/`az` CLI) omdat het per-tenant write-pad nog nooit tegen echte
per-tenant containers is uitgevoerd — daarom eerst valideren, dan flippen.
**Omkeerbaar:** ja. De flip verandert alléén waar NIEUWE writes landen; bestaande
data blijft leesbaar (absolute URI's, verbatim gelezen). Flag terug = nieuwe writes
weer shared.

---

## Wat al klaar is (code, gedeployed)

- `WAREHOUSE_CONTAINER_MODE=per-tenant` schakelt het pad om (`services/warehouse/paths.ts`,
  `container.ts`). Default staat nog op `shared`.
- **A0 pre-flip fixes** (live): `assertValidContainerName` (3–63 chars, lowercase,
  enkele interne hyphens) in `warehouseContainer()`; `getProductWarehousePath` is
  tenant-aware (geen shared-root-cachekey meer in per-tenant mode).
- **Leescompatibiliteit geverifieerd** (audit): geen enkel leespad herberekent
  Azure-URI's uit env; `connections.warehouse_path` / `product_tables.delta_path` /
  `ingested_tables.delta_path` worden verbatim gelezen. Het account-level DuckDB-secret
  leest zowel de shared `warehouse`-container (oude data) als per-tenant containers
  (nieuwe data) in dezelfde sessie.
- **Container-lifecycle** (`ensureWarehouseContainer` vóór worker-SAS-uitgifte én vóór
  productwrites; `deleteTenantWarehouseContainer` aangesloten op `purgeTenant`), met
  unit-tests (`container.test.ts`, gemockte Azure-SDK) + pad-tests (`paths.test.ts`).

## Bekende, geaccepteerde beperkingen (geen blocker voor de flip)

- Containercreatie + DuckDB-secret + Python-sidecar draaien op de account-key
  (`AZURE_STORAGE_CONNECTION_STRING`), niet op managed identity. Werkt zolang
  `shared_access_key_enabled` aan staat (dat is zo). Het per-tenant-gescopede
  SAS-secret is de latere defense-in-depth (Fase 4), niet nodig voor de flip.
- De Delta-sidecar vereist dat de container al bestaat — `ensureWarehouseContainer`
  draait vóór productwrites, dus dat is gedekt. **Expliciet verifiëren in stap 2.**

---

## Stap 1 — validatie op de staging-revisie (aanbevolen vóór de flip)

Er is geen aparte staging-omgeving; "staging" is de 0%-traffic revisie-label op de
prod-resources. We valideren met een **wegwerp-testtenant** tegen het prod-storage-
account. Risico: alleen extra containers in het account (opruimbaar) + de testtenant.

```bash
RG=<AZURE_RESOURCE_GROUP>
APP=<backend app name>          # bv. databridge-prod-backend

# 1a. Zet WAREHOUSE_CONTAINER_MODE=per-tenant op de HUIDIGE staging-revisie
#     (de nieuwste, 0% traffic). Dit maakt een nieuwe revisie; pin traffic NIET.
STAGING_REV=$(az containerapp revision list -n "$APP" -g "$RG" \
  --query "[?properties.trafficWeight==\`0\`] | [0].name" -o tsv)
az containerapp revision set-mode -n "$APP" -g "$RG" --mode multiple   # indien nog single
az containerapp update -n "$APP" -g "$RG" \
  --set-env-vars WAREHOUSE_CONTAINER_MODE=per-tenant
# → nieuwe revisie op 0% traffic met per-tenant aan. Test via de ---staging URL.
```

**Validatie-checklist (met de testtenant, op de staging-URL):**

- [ ] Nieuwe connectie + **Sync** → container `tenant-<id>` wordt aangemaakt
      (log: "ensured warehouse container").
- [ ] Twee syncs tegelijk starten → geen fout (createIfNotExists is idempotent).
- [ ] Worker schrijft onder `conn_<cid>/` in de tenant-container; `connections.warehouse_path`
      persist als `az://tenant-<id>/conn_<cid>`.
- [ ] **SAS-grens:** bevestig dat de worker-SAS niet buiten de tenant-container kan
      schrijven (cross-container write moet 403 geven).
- [ ] **Transformatie / "Prepare my data"** draait → producttabellen landen in
      `az://tenant-<id>/product_<pid>`. **Let op de Delta-sidecar:** container moet
      pre-existen (ensureWarehouseContainer draait vóór de write) — verifiëren dat
      `write_deltalake` slaagt, geen "ContainerNotFound".
- [ ] Maandrollups (parquet-pad) landen correct.
- [ ] Dashboards + Ask-AI lezen zowel **nieuwe** (per-tenant) als **legacy** (shared)
      data in dezelfde sessie.
- [ ] **Offboarding:** `purgeTenant` op de testtenant → container `tenant-<id>` is weg.

Als iets faalt: rol de staging-revisie terug (`--set-env-vars WAREHOUSE_CONTAINER_MODE=shared`)
en fix vóór de echte flip.

## Stap 2 — de flip naar productie

**Bron van waarheid is Terraform** (`infra/variables.tf` → `main.tf:683` zet de env).
`deploy.yml` draait GEEN terraform, dus de env verandert alleen via een expliciete apply.

Optie A — Terraform (persistent, aanbevolen):
```bash
cd infra
terraform apply -var="warehouse_container_mode=per-tenant"
# of: zet default = "per-tenant" in variables.tf en `terraform apply`
```

Optie B — snelle env-override (neem daarna Optie A over, anders reset de volgende
`terraform apply` het weer naar shared):
```bash
az containerapp update -n "$APP" -g "$RG" \
  --set-env-vars WAREHOUSE_CONTAINER_MODE=per-tenant
# promote deze revisie naar 100% traffic (Promote-workflow of):
REV=$(az containerapp show -n "$APP" -g "$RG" --query properties.latestReadyRevisionName -o tsv)
az containerapp ingress traffic set -n "$APP" -g "$RG" --revision-weight "$REV=100"
```

Na de flip: monitor de eerste echte syncs (container-creatie + writes) en de eerste
transformatie (sidecar). Gemengde staat is normaal en ontworpen: oude data shared,
nieuwe data per-tenant.

## Stap 3 — legacy-data migreren (incrementeel, geen big-bang)

Elke re-sync verhuist source-data, elke product-refresh verhuist productdata naar de
tenant-container. Ops-runbook: per tenant één keer een **volledige re-sync + rebuild**
triggeren (gespreid mag), daarna de oude `tenant_<id>/`-prefix in de shared `warehouse`-
container verwijderen. Een bulk-backfill-script is optioneel en pas nodig als re-syncs
voor een bron pijnlijk zijn.

## Rollback

```bash
az containerapp update -n "$APP" -g "$RG" --set-env-vars WAREHOUSE_CONTAINER_MODE=shared
# en Terraform terug naar default "shared" bij de volgende apply.
```
Nieuwe writes gaan weer naar de shared container; per-tenant containers die al data
bevatten blijven leesbaar (absolute URI's in de DB). Geen dataverlies.
