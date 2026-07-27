# Runbook: de jobs-worker aanzetten (`terraform apply`)

**Doel:** achtergrondwerk (transformaties, geplande syncs, e-mailrapporten) uit het
API-proces halen en in een eigen container zetten, zodat een zware klus van één
klant de dashboards van andere klanten niet meer kan vertragen of platleggen.

**Wie:** iemand met toegang tot het Azure-abonnement **én** tot het Terraform
state-bestand (zie stap 0 — dit is de belangrijkste stap).

**Duur:** ~15 minuten, waarvan de meeste tijd naar het lezen van de plan-output gaat.

---

## ⚠️ Stap 0 — Zoek eerst het state-bestand. Sla dit niet over.

Terraform onthoudt in een `terraform.tfstate`-bestand wat het eerder heeft
aangemaakt. In dit project staat de "remote backend" **uitgeschakeld**
(`main.tf`, het `backend "azurerm"`-blok is uitgecommentarieerd) en state-bestanden
staan in `.gitignore`. Het state-bestand staat dus **alleen op de computer waar de
vorige `terraform apply` is gedraaid** — niet in Git, niet in Azure.

```bash
# Op de machine waar eerder is gedeployed:
ls -la infra/terraform.tfstate
```

- **Bestand gevonden** → ga door naar stap 1.
- **Bestand NIET gevonden** → **STOP. Draai geen apply.** Terraform denkt dan dat
  niets bestaat en probeert alles opnieuw aan te maken: dat mislukt op
  naamconflicten, of erger, het maakt dubbele resources aan naast de draaiende
  productie. Meld dit; de jobs-worker kan dan in plaats daarvan handmatig via
  `az containerapp create` worden aangemaakt, of de state moet eerst worden
  hersteld met `terraform import`.

**Aanbevolen vervolgactie (los van deze wijziging):** zet de remote backend aan, zodat
de state in Azure staat in plaats van op één laptop. Zolang dat niet gebeurt, is
iedere apply afhankelijk van dat ene bestand.

---

## Stap 1 — Zorg dat je de geheimen hebt

Vijf waarden hebben geen standaardwaarde en moeten in `infra/prod.tfvars` staan
(niet in Git — zie `prod.tfvars.example` voor de vorm):

`pg_admin_password` · `jwt_secret` · `anthropic_api_key` ·
`credentials_encryption_key` · `neo4j_password`

Deze moeten **exact gelijk zijn aan wat er nu draait**. Een andere
`credentials_encryption_key` maakt alle opgeslagen klant-inloggegevens onleesbaar,
en een andere `jwt_secret` logt iedereen uit.

---

## Stap 2 — Kijk wat er gaat gebeuren (verandert nog niets)

```bash
cd infra
terraform init      # alleen nodig als .terraform/ ontbreekt
terraform plan -var-file=prod.tfvars
```

**Wat je hoort te zien — 4 nieuwe dingen:**

| Nieuw | Wat het is |
|---|---|
| `azurerm_container_app.jobs_worker` | de nieuwe achtergrond-container |
| `azurerm_role_assignment.jobs_worker_blob_contributor` | mag bij de opslag |
| `azurerm_role_assignment.jobs_worker_job_operator` | mag syncs starten |
| `azurerm_role_assignment.jobs_worker_acs_sender` | mag e-mail versturen |

**En wijzigingen aan bestaande dingen:**

| Wijziging | Van → naar |
|---|---|
| backend: `ROLE` | (niet aanwezig) → `api` |
| backend: cpu / memory | 0.5 / 1Gi → 1.0 / 2Gi |
| redis: command | `--maxmemory-policy noeviction` toegevoegd |

**Wat je NIET hoort te zien.** Als de plan-output een van deze toont, stop en meld het:

- ❌ Verwijderen (`destroy`) van de database, het storage account, of Key Vault
- ❌ Wijziging van het backend **image** terug naar `main-latest`
- ❌ Wijziging van `traffic_weight` op backend of frontend
- ❌ Wijziging van `WAREHOUSE_CONTAINER_MODE` naar `shared`

(De laatste drie zijn afgedekt door `lifecycle`-regels en de variabele-default, maar
controleer het — dit is precies waarvoor de plan-stap bestaat.)

De regel `Plan: 4 to add, 3 to change, 0 to destroy` is wat je verwacht.
**Staat er iets bij `to destroy`? Niet uitvoeren.**

---

## Stap 3 — Uitvoeren

```bash
terraform apply -var-file=prod.tfvars
# typ 'yes' na opnieuw de samenvatting te hebben gelezen
```

Duurt 2–5 minuten.

---

## Stap 4 — Controleren dat het werkt

```bash
RG=<resource group>

# 1. Draait de worker?
az containerapp show -n databridge-prod-jobs-worker -g "$RG" \
  --query "{status:properties.runningStatus, replicas:properties.template.scale.minReplicas}"
# verwacht: Running, 1

# 2. Staat de backend nu op API-only?
az containerapp show -n databridge-prod-backend -g "$RG" \
  --query "properties.template.containers[0].env[?name=='ROLE'].value | [0]"
# verwacht: api

# 3. Draait de worker de juiste code?
az containerapp show -n databridge-prod-jobs-worker -g "$RG" \
  --query "properties.template.containers[0].image"
# Bij de eerste apply is dit :main-latest. De eerstvolgende backend-deploy
# zet hem automatisch op de per-commit-tag (stap in deploy.yml).
```

**Functionele controle — dit is de echte test:** trigger één transformatie
("Prepare my data" of een product-refresh) en kijk of de live voortgangslog gewoon
meeloopt in de UI. Die log gaat via Redis, dus als die werkt, praten API en worker
correct met elkaar. Controleer daarna dat een geplande sync de volgende ochtend
gedraaid heeft.

---

## Terugdraaien

Er zijn twee niveaus, afhankelijk van wat er misgaat.

**De worker doet raar, maar je wilt hem houden:**
```bash
terraform apply -var-file=prod.tfvars -var="backend_role=all"
```
De backend pakt het achtergrondwerk dan weer op — precies zoals vandaag — terwijl de
worker-app blijft bestaan. Achtergrondwerk draait dan wel dubbel, dus dit is een
tijdelijke maatregel: BullMQ verdeelt klussen over beide, dus er gaat niets dubbel
uitgevoerd worden, maar het heffing-voordeel is weg.

**Alles terug naar de oude situatie:**
```bash
terraform destroy -var-file=prod.tfvars -target=azurerm_container_app.jobs_worker
terraform apply -var-file=prod.tfvars -var="backend_role=all"
```

---

## Waarom `min_replicas = 1` (en dus ~€35/maand)

Deze container mag niet naar nul schalen. Geplande klussen in BullMQ worden
vrijgegeven door een *draaiende* worker — dat is geverifieerd in BullMQ's eigen
broncode, en hun documentatie zegt het letterlijk: *"If there are no workers running,
repeatable jobs will not accumulate next time a worker is online."* Automatisch
opschalen bij drukte helpt hier niet: schalen op "wachtende klussen" is een
patstelling (die lijst wordt alleen gevuld dóór een worker) en schalen op "geplande
klussen" schaalt nooit terug naar nul.

Azure rekent mogelijk een lager idle-tarief als de container echt stil ligt, maar dat
vereist minder dan 1000 bytes/seconde verkeer — wat een worker die elf wachtrijen
bewaakt misschien niet haalt. **Reken op ~€35/maand en meet het daarna** in Azure
Cost Analysis.

`max_replicas` staat bewust op 1: de opruimroutine voor vastgelopen klussen draait in
elke worker en kijkt alleen naar ouderdom, niet naar eigenaarschap. Een tweede replica
zou het lopende werk van de eerste als mislukt wegschrijven. Opschalen kan pas na een
leader-election (staat in het plan).
