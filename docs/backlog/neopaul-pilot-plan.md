# Neopaul-pilot: van Odoo-export tot showcase

**Status:** plan van record, 2026-09-21. Geen productcode gewijzigd in deze
sessie — dit document zegt wat er gebouwd moet worden, in welke volgorde, en
wat Dries (Neopaul) moet aanleveren.
**Aanleiding:** de owner wil het platform testen met een eerste klant, Neopaul
(Dries Martens, mail van 2026-06-05). Neopaul draait Odoo en wil **geen
API-koppeling**: ze exporteren zelf uit Odoo en leveren bestanden aan.
**Vervangt** `odoo-raw-tables-readiness.md` (2026-09-08) op drie punten — zie §0.
Elke claim over Clarion is tegen deze codebase geverifieerd (`file:line`);
elke claim over Odoo is geverifieerd tegen de Odoo 17.0-broncode op GitHub of
de officiële documentatie-repo (odoo.com zelf is vanuit deze omgeving
geblokkeerd). Bronnen in §9.

---

## 0. Wat er veranderd is sinds 8 september, en waarom dit een nieuw plan is

1. **Het exportadvies van 8 september was fout.** Dat document zei: vink
   *"Ik wil gegevens bijwerken (import-compatibele export)"* aan, dan komen
   relatievelden als id's. Klopt half — en het halve dat niet klopt is fataal:
   in import-compatibele modus **verbergt Odoo elk read-only veld**
   (`addons/web/controllers/export.py:332-337`, Odoo 17.0:
   `if field.get('readonly'): continue`). Op `account.move.line` zijn dat
   onder meer `move_id`, `date`, `journal_id`, `company_id`, `balance`,
   `amount_residual`, `reconciled`, `full_reconcile_id`, `price_subtotal`,
   `parent_state`; op `account.move` **`move_type`, `state`, alle bedragen en
   `payment_state`** — geverifieerd veld per veld tegen `account_move_line.py`
   en `account_move.py` (17.0). Een import-compatibele export van de
   boekingsregels bevat dus **niet eens de link naar de boeking**. Het juiste
   recept staat in §3 en is de gewone export met ID-kolommen.
2. **Postgres is nu een framework-connector** (2026-09-11), niet meer het
   oude ETL-pad. Voor Neopaul is dat irrelevant — ze willen geen directe
   toegang, en Odoo Online geeft die sowieso niet — maar de kanttekening in
   het oude document is achterhaald.
3. **De Odoo-kennis is nu DATA** (`packages/connectors/src/odoo/package/`,
   2026-09-20): 21 datasets met 242 gedocumenteerde velden, 40+ relaties en
   een getest sterschema (9 dimensies, 6 facts, 5 producten). Een
   bestandsgebaseerde Odoo-connector kan dat pakket **hergebruiken** in plaats
   van het te dupliceren. Dat maakt de aanbeveling van §4 mogelijk en goedkoop.

Wat nog steeds geldt uit het oude document: de 15 MB-grens per bestand, de
"één connectie = één bron voor de ontwerper"-regel, de vier balansgedreven
use cases, het ontbreken van kostprijs en van een 13-weken motor.

---

## 1. De zes use cases van Dries, vertaald naar data en naar Clarion

| # | Use case (mail) | Wat het inhoudelijk is | Data die het nodig heeft | Clarion-mechanisme | Status |
|---|---|---|---|---|---|
| 1 | Kasstroomoverzicht 2–3 jaar, werking / investeringen / financiering | Indirecte methode: resultaat + niet-kasposten + Δ werkkapitaal; Δ vaste activa; Δ eigen vermogen en schulden | Geboekte journaalregels met `account_id`, `debit/credit`, `date`; rekeningen met `account_type` en (als ze gezet zijn) de kasstroom-**tags** | Maandelijkse saldotabel per rekening (te bouwen in de template) + classificatie uit `account_type` met een **managed grid** als override | Bouwen (§4.3), grid bestaat |
| 2 | Werkkapitaal + DSO / DIO / DPO per jaar | Saldi 40x / 3x / 44x per periode, gedeeld door omzet / kostprijs / aankopen × dagen | Idem 1, plus **`account.partial.reconcile`** voor saldi *op een datum in het verleden* | Zelfde saldotabel + een afletteringstabel (te bouwen) | Bouwen (§4.3) |
| 3 | Rollende 13-weken kasplanning | Deterministische roll-forward van open posten op vervaldatum + vaste verplichtingen | Open klanten/leveranciers met `date_maturity` en restbedrag, orderboek, **vaste verplichtingen die niet in Odoo zitten** | Product-tabel per week + grid met vaste verplichtingen + dashboard | Bouwen, het duurste stuk (§4.5) |
| 4 | Managementrapportering, 5 KPI's | Omzet, marge, cash, werkkapitaal, openstaande klanten | Alles hierboven | Dashboards, pulse-watchlist, ochtendbriefing, Excel-add-in | **Bestaat** |
| 5 | Margeanalyse | Omzet − kostprijs, per product / klant / periode | Kostprijs: `stock.valuation.layer` óf `sale.order.line.purchase_price` óf klasse-60-rekeningen | `fact_invoice_lines` (bestaat) + kostprijsbron | Half — hangt aan vraag 3 in §7 |
| 6 | Actieve opvolging werkkapitaal | Drempels op DSO, betaaltermijnen, voorraad | KPI's uit 2 | Pulse + quality alerts | **Bestaat** |

Twee dingen die de mail niet zegt maar die het plan bepalen:

- **Vier van de zes zijn balansgedreven.** Clarion's facts zijn transactie-
  facts; een saldo op een datum is een lopende som die het model bij elke
  vraag opnieuw moet schrijven — precies waar een fout antwoord er plausibel
  uitziet. Daarom is de **maandelijkse saldotabel** het eerste wat gebouwd
  wordt, niet het laatste.
- **Marge op bedrijfsniveau is haalbaar zonder voorraadwaardering.** Een
  Belgische boekhouding draagt de kostprijs van verkochte goederen in klasse
  60 (incl. 609 voorraadwijziging), en Odoo's `account_type` markeert die
  rekeningen als `expense_direct_cost`. Brutomarge = `income` − `expense_direct_cost`
  is dus een GL-vraag. Wat ontbreekt zonder `stock.valuation.layer` of de
  margemodule is marge **per product of per klant**. Zeg dat zo tegen Dries.

---

## 2. Aanbeveling in één alinea

Bouw een kleine **`odoo_export`-connector** (één connectie = één ZIP met de
Odoo-exportbestanden, één bestand per model, per boekjaar gesplitst waar
nodig) die de exportidiomen van Odoo — Engelse kolomlabels, `Relatie/ID`-
kolommen, selectielabels, lege cellen voor nul — omzet naar de technische
vorm die het bestaande Odoo-bronpakket verwacht. Daardoor werken de 242
gedocumenteerde velden, de gedocumenteerde relaties **en het geteste
sterschema** ongewijzigd op de aangeleverde bestanden, zonder AI-ontwerp.
Breid dat sterschema uit met de drie CFO-tabellen die Neopaul's vragen
dragen (saldo per maand, afletteringen, open posten), en bouw de 13-weken
planning als laatste, op die basis. Het alternatief — een Excel-werkboek
door de generieke Excel-connector en de AI-ontwerper — werkt voor een
eerste blik, maar levert geen showcase (§4.7).

---

## 3. De export: wat Dries precies moet doen

Dit is de instructie die naar Dries gaat (de klantversie is de artifact
"Odoo-export Neopaul", v2). Elke regel heeft een reden, hieronder genoemd.

### 3.1 Gewone export, NIET import-compatibel

Lijstweergave → records selecteren (of "alle N selecteren") → Acties →
**Exporteren**. Het vinkje *"Ik wil gegevens bijwerken"* **uit** laten.
Reden: §0 punt 1 — import-compatibel verbergt read-only velden, en dat zijn
net de financiële.

### 3.2 Taal van de gebruiker op Engels (VS) tijdens het exporteren

In de gewone export zijn de **kolomkoppen de schermlabels** in de taal van
de exporterende gebruiker (`export.py:347`: `name = … field['string']`), en
**selectievelden komen als label**, niet als sleutel (`fields.py`
`Selection.convert_to_export`): `Posted` / `Geboekt`, `Customer Invoice` /
`Klantfactuur`. De connector vertaalt Engelse labels naar technische namen
met een vaste woordenlijst; Nederlandse labels zou hij ook kunnen leren,
maar dat is een tweede woordenlijst die per Odoo-versie kan verschuiven.
Eén klik in Voorkeuren vóór het exporteren, terugzetten erna.

### 3.3 De ID-kolommen — dit is de kern

In de gewone export biedt Odoo per record een veld **"ID"** (de numerieke
database-id, intern `.id`; `export.py:318`) en voor elk relatieveld, na
openklappen, **"<Relatie>/ID"**. Dat zijn de kolommen die de joins dragen.
Een relatieveld zónder `/ID` exporteert de **schermnaam** (`fields.py`
`Many2one.convert_to_export → display_name`): `400000 Handelsdebiteuren` in
plaats van `42`. Dat breekt elke join, en het breekt stil. Dus voor elk
relatieveld in de lijst hieronder: klap open, kies **ID**.

Maximaal twee niveaus diep (`export.py:355`): `partner_id/vat` kan,
`partner_id/country_id/code` niet. We hebben geen derde niveau nodig.

### 3.4 Formaat en bestanden

- **CSV**, niet XLSX. CSV heeft geen rijlimiet en is lichter; het Odoo-CSV
  is UTF-8 zonder BOM, komma-gescheiden, elk veld tussen aanhalingstekens,
  ISO-datums (`pycompat.csv_writer`, `quoting=1`). De CSV-lezer van Clarion
  detecteert dit correct (`packages/connectors/src/spreadsheet/csvReader.ts`).
- **Eén bestand per model.** Odoo noemt het bestand
  `<Modelnaam> (<technische.naam>).csv` — bv. `Journal Item (account.move.line).csv`
  (`export.py:445-453`). **Niet hernoemen**: de connector leest het model
  uit de naam tussen haakjes.
- **`account.move.line` per boekjaar exporteren** (filter op datum in de
  lijst, vier bestanden: 2023, 2024, 2025, 2026). Reden: een UI-export loopt
  synchroon in één HTTP-request en wordt afgebroken door de tijdslimiet van
  de worker (Odoo Online / Odoo.sh: ~15 min, zelf gehost standaard 120 s).
  De connector plakt de jaarbestanden weer aan elkaar en ontdubbelt op ID.
- Alles in **één ZIP** aanleveren. Clarion's plafond is 15 MB per upload
  (`packages/connectors/src/csv/schema.ts:20`); gezipte CSV comprimeert
  ruwweg 8–10×, dus dat is ~120–150 MB aan platte tekst, ruim voldoende.
  Per tabel geldt 250.000 rijen (`spreadsheet/xlsxReader.ts:65`) — boven die
  grens weigert Clarion het bestand hard in plaats van een halve tabel te
  laden (`tabular.ts` `assertSheetComplete`). Dat is de reden voor vraag 1
  in §7.

### 3.5 Filters op de lijst vóór het exporteren

- `account.move.line` en `account.move`: filter **Geboekt** (`parent_state`
  / `state` = posted). Ontwerpboekingen vertekenen elk saldo, en de
  statuskolom is via §3.1 wel exporteerbaar maar de filter is zekerder.
- Datums: vanaf **1 januari 2023**. Stamgegevens (rekeningen, dagboeken,
  relaties, artikelen, betalingsvoorwaarden) integraal, zonder datumfilter.
- Geen groepering in de lijst: gegroepeerde data kan niet naar CSV
  (`export.py`: "Exporting grouped data to csv is not supported").

### 3.6 Rechten

Exporteren vereist de groep `base.group_allow_export` ("Toegang tot
exportfunctie", Instellingen › Gebruikers, zichtbaar in debugmodus). In Odoo
15–18 staat die standaard aan voor interne gebruikers; **in Odoo 19 niet
meer** (privilege "Export", alleen via `group_system` geïmpliceerd). Plus
leesrechten op boekhouding voor de modellen zelf. Wie exporteert moet een
boekhoudgebruiker met exportrecht zijn — of Dries zelf als beheerder.

### 3.7 De afletteringstabel — het ene model zonder menu

`account.partial.reconcile` (welke betaling heeft welke factuur voor welk
bedrag op welke datum afgeletterd) is **onmisbaar** voor DSO/DPO en voor
elk saldo "op een datum in het verleden": het huidige `amount_residual` is
alleen de stand van vandaag. Het model heeft geen menu. Twee wegen:

1. Als beheerder, in debugmodus, de URL
   `https://<instantie>/web#model=account.partial.reconcile&view_type=list`
   openen (Odoo 16/17; op 17+ ook `/odoo/action-…` maar de `#model=`-vorm
   werkt), alles selecteren, exporteren met `ID`, `Debit Move/ID`,
   `Credit Move/ID`, `Full Reconcile/ID`, `Amount`, `Max Date`, `Company/ID`.
2. Terugval: vanuit Boekingsregels de velden `Matched Debits/…` en
   `Matched Credits/…` mee-exporteren — dat levert één rij per aflettering
   (one2many-expansie), wat de connector kan hersorteren maar wat de
   export tot ~2× groter maakt.

Weg 1 is de bedoeling; weg 2 bestaat zodat het nooit een blokkade is.

### 3.8 Kasstroomtags op de rekeningen

De Community-module `account` definieert drie tags voor het kasstroomoverzicht
(`addons/account/data/account_data.xml`, 17.0: `account_tag_operating`
"Operating Activities", `account_tag_financing`, `account_tag_investing`).
De Enterprise-rapportage gebruikt die (directe methode, cash = `asset_cash`).
`tag_ids` is een gewone many2many op `account.account` en exporteerbaar
(`Tags/ID` of de namen). **Als Neopaul's boekhouder ze gezet heeft, is de
classificatie klaar** en hoeven we ze alleen te lezen. Zo niet, dan leidt
Clarion een default af uit `account_type` (§5.1) en corrigeert Dries in
een grid.

### 3.9 Wat de waarden er uitzien en wat de connector ermee doet

Allemaal uit `odoo/fields.py` (`convert_to_export`) en `pycompat.py`:

| Odoo schrijft | Betekenis | Connector doet |
|---|---|---|
| lege cel in een bedragkolom | **0.00** (Monetary valt onder `if not value: return ''`) | leest als 0 — **niet** als NULL |
| `True` / lege cel (CSV) | boolean | leest `True` → true, leeg → false in booleaanse kolommen |
| `2026-06-05` | datum | DATE |
| `2026-06-05 15:23:37` | datetime in **de tijdzone van de exporteur**, zonder offset | DATE (dagdeel volstaat voor alles hier) |
| `1234.5` | float, punt-decimaal, geen duizendtallen | DOUBLE |
| `Posted`, `Customer Invoice`, `Receivable` | selectielabel | vaste woordenlijst → `posted`, `out_invoice`, `asset_receivable`; **onbekend label = melding, nooit stil** |
| `'-ABC` | tekstveld dat met `-`, `+` of `=` begon (formule-injectiebescherming) | apostrof strippen |
| `{"12": 100.0}` | `analytic_distribution` (JSON) | tekst laten, niet gebruikt |

### 3.10 De exportlijst

Kolomnaam = het Engelse label zoals Odoo 17 het toont; tussen haakjes de
technische naam die de connector eruit maakt. **Vet** = zonder dit veld
vervalt een deel van de analyse. `/ID` betekent: relatieveld openklappen en
"ID" kiezen.

**Kern (kasstroom, werkkapitaal, DSO/DPO, resultatenrekening):**

| Model → tabel | Velden |
|---|---|
| `account.move.line` → `account_move_line` (per boekjaar) | **ID**, **Journal Entry/ID** (`move_id`), **Date**, **Due Date** (`date_maturity`), **Account/ID**, **Partner/ID**, **Journal/ID**, **Company/ID**, **Debit**, **Credit**, **Balance**, **Residual Amount** (`amount_residual`), **Reconciled**, Matching # (`matching_number`), Full Reconcile/ID, Currency/ID, Amount in Currency, Label (`name`), Product/ID, Quantity, Unit Price, Subtotal (`price_subtotal`), Total (`price_total`), Display Type, Parent State |
| `account.move` → `account_move` | **ID**, **Number** (`name`), **Type** (`move_type`), **Status** (`state`), **Date**, **Invoice/Bill Date** (`invoice_date`), **Due Date** (`invoice_date_due`), **Partner/ID**, **Journal/ID**, **Company/ID**, Currency/ID, Untaxed Amount, Tax, Total, Amount Due (`amount_residual`), **Payment Status** (`payment_state`), Reference (`ref`), Origin (`invoice_origin`), Payment Terms/ID |
| `account.account` → `account_account` | **ID**, **Code**, **Account Name**, **Type** (`account_type`), Allow Reconciliation (`reconcile`), Deprecated, **Tags** (`tag_ids` — namen volstaan), Company/ID |
| `account.journal` → `account_journal` | **ID**, **Journal Name**, **Short Code**, **Type**, Company/ID |
| `account.partial.reconcile` → `account_partial_reconcile` | **ID**, **Debit Move/ID**, **Credit Move/ID**, **Amount**, **Max Date**, Full Reconcile/ID, Company/ID |
| `res.partner` → `res_partner` | **ID**, **Name**, Tax ID (`vat`), Is a Company, Related Company/ID (`parent_id`), Customer Rank, Vendor Rank, Country/ID, Customer Payment Terms/ID, Vendor Payment Terms/ID, City, Zip |
| `account.payment.term` → `account_payment_term` | **ID**, **Payment Terms** (`name`) |
| `res.company` → `res_company` | **ID**, **Company Name**, Currency/ID |

**Marge en voorraad** (zie vraag 3 in §7):

| Model → tabel | Velden |
|---|---|
| `stock.valuation.layer` → `stock_valuation_layer` | **ID**, **Created on** (`create_date`), **Product/ID**, **Quantity**, **Unit Value** (`unit_cost`), **Total Value** (`value`), Remaining Qty, Remaining Value, Stock Move/ID, Journal Entry/ID, Company/ID |
| `product.product` → `product_product` | **ID**, **Product Template/ID**, Internal Reference (`default_code`), Barcode, Active |
| `product.template` → `product_template` | **ID**, **Name**, **Product Category/ID** (`categ_id`), Product Type (`type`), Sales Price (`list_price`), Cost (`standard_price`), Unit of Measure/ID |
| `product.category` → `product_category` | **ID**, **Name**, Complete Name, Parent Category/ID |
| `stock.quant` → `stock_quant` | **ID**, **Product/ID**, **Quantity**, Location/ID, Reserved Quantity |

**Vooruitblik (13-weken plan, orderboek):**

| Model → tabel | Velden |
|---|---|
| `account.payment` → `account_payment` | **ID**, **Date**, **Amount**, **Payment Type**, **Status**, Partner Type, Partner/ID, Journal/ID, Journal Entry/ID, Currency/ID |
| `sale.order` → `sale_order` | **ID**, **Order Reference** (`name`), **Customer/ID**, **Order Date**, **Status**, **Invoice Status**, Delivery Date (`commitment_date`), Untaxed Amount, Total, Company/ID |
| `sale.order.line` → `sale_order_line` | **ID**, **Order Reference/ID** (`order_id`), **Product/ID**, **Subtotal**, Quantity (`product_uom_qty`), Delivered Quantity, Invoiced Quantity, Unit Price, Discount (%), **Cost** (`purchase_price` — alleen met de margemodule) |
| `purchase.order` → `purchase_order` | **ID**, **Order Reference**, **Vendor/ID**, **Order Deadline** (`date_order`), **Status**, **Billing Status** (`invoice_status`), Expected Arrival (`date_planned`), Untaxed Amount, Total, Company/ID |
| `purchase.order.line` → `purchase_order_line` | **ID**, **Order Reference/ID**, **Product/ID**, **Subtotal**, Quantity (`product_qty`), Received Qty, Billed Qty, Unit Price |

**Versieverschillen die de labels of velden raken** (uit de 15.0–19.0-branches):
Odoo 18 maakt `account.account.code` bedrijfsafhankelijk en `company_id` een
many2many (`company_ids`); `account.payment` erft in 18 niet meer van
`account.move` (eigen `state`: draft / in_process / paid / canceled); Odoo
18 vervangt `type = product` door `is_storable`; Odoo 16 introduceerde
`account_type` (vóór 16: `user_type_id` + `internal_type`) en
`analytic_distribution`. **Vandaar vraag 2 in §7: de versie bepaalt de
woordenlijst.**

---

## 4. Wat Clarion moet bouwen vóór de data komt

### 4.1 De `odoo_export`-connector — het werk dat de rest goedkoop maakt

Een nieuwe `SourceConnector` in `packages/connectors/src/odoo_export/`,
gebouwd naar de spelregels van `docs/SOURCE_ONBOARDING.md` (Tier 2:
vendor-gedocumenteerd, geen transport). Effort: **3–4 dagen**.

**Config** (`schema.ts`): `filename` + `fileContent` (base64, `contentEncoding:
'base64'` zodat de wizard vanzelf een bestandskiezer rendert —
`frontend/app/sources/add-source/page.tsx:782`), zoals de Excel-connector.
Eén ZIP; ook een enkele `.xlsx` met één tab per model wordt aanvaard voor
de kleine sets. De ZIP-lezer bestaat al als code: `xlsxReader.ts` parseert
een zip-central-directory met `DecompressionStream('deflate-raw')` — dat
stuk wordt een gedeelde `zipReader`. Zelfde 15 MB-plafond en dezelfde
"hard weigeren boven de rijlimiet"-regel.

**Model uit de bestandsnaam**: `\(([a-z_.]+)\)` uit `Journal Item
(account.move.line) (2).csv`; terugval op een kale `account.move.line.csv`
of `account_move_line.csv`; ambigu of onbekend → in `testConnection`
genoemd, nooit stil overgeslagen. Meerdere bestanden voor één model
(boekjaren) worden **aaneengeplakt en op `id` ontdubbeld**.

**Kopnormalisatie** (`headers.ts`, puur, unit-getest): `ID` → `id`;
`<Label>/ID` → `<veld>`; `<Label>` → `<veld>` via een woordenlijst per model
met Odoo's Engelse `string`-waarden voor exact de velden uit §3.10 (~120
regels, geen dynamiek: de labels komen uit de 17.0-bron en krijgen per
versie een alias waar ze verschoven zijn). Was de export tóch
import-compatibel (`partner_id/id`), dan wordt de technische naam
doorgelaten en de externe id als tekstsleutel gebruikt — het werkt dan
half, en de melding zegt welke velden ontbreken. Een kop die op geen enkele
lijst staat blijft **als kolom behouden** onder zijn gesaneerde naam
(`sanitiseIdentifier`) en wordt gemeld — een maatwerkveld van de klant is
data, geen fout.

**Waardenormalisatie** (§3.9): selectielabels → sleutels via vaste
woordenlijsten (`move_type`, `state`, `payment_state`, `display_type`,
`account_type`, `journal.type`, `payment_type`, `partner_type`,
`invoice_status`, `product.type`); lege Monetary → 0; `True`/leeg → boolean
op kolommen die het pakket als boolean kent; apostrof-prefix strippen;
datetime → DATE. Schema **expliciet** naar de writer (`columns`), afgeleid
uit het pakket (`datatype` per veld) — geen `auto_detect`, precies de
Tier-2-regel uit het playbook. Onbekend selectielabel → warning met het
label erin.

**Kennis = het bestaande pakket, ongewijzigd.** `describeEntities` levert
`ODOO_COLUMN_DOCS` (`packages/connectors/src/odoo/catalog.ts:108`) als
`provenance: 'curated'` met `dataType` = het Odoo-veldtype uit het pakket;
`getKnownRelationships` = `ODOO_KNOWN_RELATIONSHIPS` gefilterd op de
aangeleverde modellen; `getBusinessKeys` = `id` overal;
`getStarSchemaTemplate` = `ODOO_STAR_SCHEMA_TEMPLATE`. De template-selectie
zoekt de connector op `connector_type` in het register en vraagt hem zijn
template (`backend/src/services/starSchemaTemplates.ts:127-128`,
aangeroepen vanuit `busMatrixOrchestrator.ts:261`) — een nieuw type met
dezelfde template werkt dus **zonder backend-wijziging**. De template-SQL
joint op `aml.move_id = am.id` en `pp.product_tmpl_id = pt.id`
(`odoo/package/model/fact_invoice_lines.yaml`, `dim_product.yaml`): met de
numerieke `/ID`-kolommen uit §3.3 zijn dat exact de kolommen die aankomen.

**`supportsIncremental: false`**, `canCheckpoint: false`; opnieuw uploaden
is verversen (de Excel-regel). `testConnection` rapporteert per bestand:
model, rijen, boekjaren, gemapte / onbekende koppen, ontbrekende
verplichte velden, tijdzone-aanname — de enige plek waar Dries een foute
export kan zien vóór ze geladen wordt.

**Tegel** op `/sources`: "Odoo (exportbestanden)", naast de API-tegel, met
een eigen zin ("Upload wat je zelf uit Odoo exporteerde — zonder API-
koppeling"). Dezelfde `CONNECTOR_MARKS.odoo`.

### 4.2 Uitbreiding van het Odoo-bronpakket (rendeert ook voor de API-connector)

Twee datasets erbij in `odoo/package/datasets/`, effort **een halve dag**,
conformance-suite dekt ze:

- `account_partial_reconcile` (`debit_move_id`, `credit_move_id`,
  `full_reconcile_id`, `amount`, `max_date`, `company_id`) met de twee
  relaties naar `account_move_line`. De API-connector krijgt hem gratis mee
  (allowlist 21 → 22).
- `tag_ids` op `account_account` (many2many; de API-connector flattent naar
  een lijst id's, de export levert namen — het pakket declareert de
  betekenis, niet het formaat).

### 4.3 De CFO-tabellen in de template (shipped content, elke Odoo-klant)

Drie tabellen in `odoo/package/model/`, product **Finance**, effort **2–3
dagen** inclusief de DuckDB-materialisatietest die de template-suite al
draait (`odoo/starSchemaTemplate.test.ts` materialiseert elke tabel en runt
elke KPI):

1. **`fact_account_balance_monthly`** — (`company_id`, `account_id`,
   `month`) → beginsaldo, debet, credit, eindsaldo, uit geboekte
   `account_move_line`. Dit is de tabel waar kasstroom, werkkapitaal en de
   DSO/DPO-noemers vandaan komen; alles wat "op een datum" is wordt een
   `WHERE month = …` in plaats van een window-functie.
2. **`fact_settlements`** — uit `account_partial_reconcile` gejoind op beide
   regels: factuurregel, betalingsregel, bedrag, factuurdatum, vervaldatum,
   `max_date` (= effectieve betaaldatum), dagen te laat, partner, klant/
   leverancier. Draagt de **werkelijke inningstermijn en betaaltermijn**
   (gewogen naar bedrag), en maakt `amount_residual` op elke datum
   herleidbaar.
3. **`fact_open_items`** — open klanten- en leveranciersposten met
   `date_maturity`, restbedrag, ouderdomsbucket (0–30/31–60/61–90/90+) en de
   afgesproken termijn uit `dim_payment_term`. Basis voor de ouderdoms-
   analyse, voor "openstaande klanten" op het dashboard en voor het
   13-weken plan.

KPI's erbij op de template (`clarion.template.kpis`): omzet
(`income`), brutomarge (`income` − `expense_direct_cost`), cash
(`asset_cash` eindsaldo), openstaande klanten (`asset_receivable`),
openstaande leveranciers (`liability_payable`), voorraad (`asset_current`
rekeningen klasse 3 — override via grid), werkkapitaal (klanten + voorraad −
leveranciers), DSO / DPO / DIO (formules in §5.2). Elk met `question_text`
in de eerste persoon, zodat de topicpagina ze als vraag toont.

### 4.4 Eén configuratie-flip

`.ops/star-schema-design` staat op `ai` sinds 2026-08-18. De template-route
staat daardoor overal uit (`STAR_SCHEMA_TEMPLATES_DISABLED=1`,
`starSchemaTemplates.ts:120`). **Terug naar `templates`** vóór de
Neopaul-build. Het is een globale schakelaar: de bestaande Exact
Online-tenant merkt er niets van tót een *Rebuild*, waarbij AI-ontworpen
topics vervangen worden door template-topics. Dat is het gedocumenteerde
gedrag en de gedocumenteerde voorkeur; alleen noteren voor wie die tenant
herbouwt.

### 4.5 De 13-weken kasplanning — bouwwerk, als laatste

Een product-tabel `fact_cash_plan_weekly` (week, bron, bedrag in, bedrag
uit) uit vier stromen: open klantenposten per **verwachte** inningsweek
(vervaldatum + de gemiddelde vertraging van die klant uit
`fact_settlements`), open leveranciersposten per vervalweek, niet-
gefactureerd orderboek per verwachte factuurweek, en de **vaste
verplichtingen** uit een managed grid (lonen, btw, huur, leningen — met
maand/kwartaal-herhaling). Beginsaldo = cash uit de saldotabel. Een
dashboard met gestapelde staaf (in/uit) en lijn (cumulatieve kas), gefilterd
op scenario. Effort **2–3 dagen** na §4.3; niet in de template (de vaste
verplichtingen zijn tenantinhoud), wel als script/notebook herbruikbaar.
`POST /query/forecast` is hier bewust **niet** de motor: dat is regressie
over een reeks (`forecastEngine.ts`), en een kasplan is een roll-forward.

### 4.6 Klein en optioneel

- **Waterfall-widget** voor het kasstroomoverzicht (`widgetContracts.ts`
  kent hem niet). Gestapelde staaf of tabel volstaat voor de eerste demo;
  een waterfall is ~een halve dag op ECharts.
- Een `kind: 'match'`-vrij pad: Neopaul heeft één bron, cross-source is
  niet aan de orde.

### 4.7 Plan B, eerlijk: zonder te bouwen

Eén Excel-werkboek (tab per model, Engelse labels, `/ID`-kolommen) via de
bestaande Excel-connector + de AI-ontwerper werkt vandaag. Wat je dan
krijgt: kolommen als `Journal_Entry_ID` en `Residual_Amount`, selectiewaarden
als `Posted`, geen enkele vendor-beschrijving, geen relaties uit het pakket
(die zijn op `connector_type` geknoopt — `odoo/catalog.ts`, gelezen via
`SchemaProfiler`), en een AI-sterschema dat op de labelnamen moet
improviseren. Goed voor "kijk, het laadt en je kan vragen stellen" in één
dag; niet goed voor een showcase die op Odoo's eigen cijfers moet
reconciliëren. Bewaar dit als noodrem, niet als plan.

---

## 5. De inhoud: definities die vóór de demo vast moeten liggen

Deze horen in de **glossary met links** (2026-09-20): elke term wijst naar
zijn KPI of kolom, en het model krijgt dat als feit mee.

### 5.1 Kasstroomclassificatie (indirecte methode, default uit `account_type`)

| `account_type` | Categorie | PCMN-klasse (België) |
|---|---|---|
| `income`, `income_other`, `expense`, `expense_direct_cost`, `expense_depreciation` | resultaat (+ afschrijvingen terug bij werking) | 6x / 7x |
| `asset_receivable`, `asset_current`, `asset_prepayments`, `liability_payable`, `liability_current`, `liability_credit_card` | Δ werkkapitaal → werking | 3x, 40–41, 44–49 |
| `asset_fixed`, `asset_non_current` | investeringen | 2x |
| `equity`, `equity_unaffected`, `liability_non_current` | financiering | 1x, 17x |
| `asset_cash` | de kas zelf (sluitpost) | 55–57 |

Als Odoo's kasstroomtags (§3.8) aanwezig zijn, winnen die per rekening.
Daarbovenop een managed grid `kasstroom_categorie` (rekeningcode →
categorie), gelinkt aan `dim_account.account_code` zodat de dekkingsteller
zegt "57 van de 62 rekeningen ingedeeld" en Dries de rest in twee minuten
doet. Odoo's Enterprise-rapport gebruikt de **directe** methode (tegen-
rekeningen van bank/kas-bewegingen); de indirecte is wat Dries beschrijft
("opgesplitst in werking / investeringen / financiering" over jaren) en wat
uit de saldotabel volgt zonder de bank-tussenrekeningen (`Outstanding
Receipts/Payments`) te moeten ontwarren. Zeg het verschil tegen hem.

### 5.2 DSO / DPO / DIO — twee definities, allebei tonen

- **Balansmethode** (jaar per jaar, zoals gevraagd): DSO = gemiddeld saldo
  klanten (`asset_receivable`) / omzet incl. btw over de periode × dagen.
  DPO = gemiddeld saldo leveranciers / (aankopen `expense_direct_cost` +
  investeringen) incl. btw × dagen. DIO = gemiddelde voorraad / kostprijs
  verkochte goederen × dagen.
- **Werkelijke termijn** uit `fact_settlements`: gewogen gemiddelde van
  (betaaldatum − factuurdatum) per klant, per leverancier. Dit is wat Odoo
  Enterprise in het Executive Summary "Average debtors days" noemt — en dat
  cijfer is het **ijkpunt**: als Clarion's getal daarvan afwijkt, moet dat
  verklaard zijn vóór de demo (btw in de noemer, creditnota's, voorschotten).

### 5.3 Reconciliatie als onderdeel van de showcase

Drie cijfers uit Odoo zelf naast drie cijfers uit Clarion, op dezelfde
datum: proefbalans-totalen per klasse, openstaande klanten (Aged
Receivable "as of"), en Average debtors days. Vraag Dries die drie rapporten
als PDF mee te sturen met de export. Een platform dat zijn eigen cijfers
tegen het bronsysteem bewijst is het verkoopargument; dit is de
goedkoopste manier om het te tonen.

---

## 6. Stappenplan

| Week | Wie | Wat | Uitkomst |
|---|---|---|---|
| 0 | Owner ↔ Dries | De vragen uit §7 (eerst vraag 1 en 2). Klantversie van de exportinstructie (artifact v2) sturen. **Verwerkersovereenkomst of minstens een NDA** vóór de eerste bestanden: de export bevat namen, e-mails en btw-nummers van hun klanten; de legal-teksten van Clarion zijn nog drafts (`LEGAL_IN_FORCE = false`). Tenant aanmaken, Dries als analyst. | Go / no-go op volume en versie; papier op orde |
| 1 | Clarion | §4.1 connector + §4.2 pakket + §4.4 flip. Testen op een **zelfgemaakte export** uit een Odoo-demo (odoo.com/trial of een lokale Community-instantie, 30 min) zodat de woordenlijsten tegen echte labels staan, niet tegen de bron alleen. | Connector groen op een echte Odoo 17-export |
| 1 (parallel) | Dries | Exporteert volgens §3, zipt, levert aan met de drie Odoo-rapporten uit §5.3. | ZIP + drie PDF's |
| 2 | Clarion | Upload → `testConnection`-rapport doornemen (onbekende koppen!) → sync → Analyse (curated docs landen verbatim, AI alleen op maatwerkvelden) → Build "Create my topics" (template) → **reconciliëren** (§5.3) → §4.3 tabellen + KPI's → glossary-termen met links → grids (kasstroomcategorie, vaste verplichtingen) → dashboards. | Cijfers kloppen tegen Odoo; Finance / Sales / Purchasing topics staan |
| 3 | Clarion | §4.5 13-weken plan; pulse-watchlist (DSO, openstaande klanten, cash); Verified saved questions voor de demo; Excel-add-in token voor Dries. Droogloop van het draaiboek (§8). | Demo-klaar |
| 3 | Owner ↔ Dries | Showcase op Neopaul's data. Afspraak over de **cadans** van her-uploads (maandelijks na afsluiting is realistisch) — en de deur naar de read-only API-koppeling open laten: de Odoo-connector is read-only op constructie (alleen `search_read`/`read`/`fields_get`, `odoo/transport.ts`), met een API-sleutel die zij zelf intrekken. | Pilot loopt |

Twee weken Clarion-werk vóór de data er is, één week met de data. De
connector (week 1) is het enige stuk dat op het kritieke pad staat; §4.3 en
§4.5 kunnen ook op een demo-export gebouwd worden als Dries later levert.

---

## 7. Vragen aan Dries — in deze volgorde

1. **Hoeveel boekingsregels sinds 1 januari 2023?** (Boekhouding › Boekingsregels,
   filter Geboekt + datum, het aantal staat rechtsboven.) Onder ~250.000
   past het in één tabel; daarboven splitsen we anders. Beslist het meeste.
2. **Welke Odoo-versie en editie — Community of Enterprise?** Versie bepaalt
   de veldnamen (§3.10); Enterprise bepaalt of de drie referentierapporten
   (§5.3) bestaan.
3. **Staat de voorraadwaardering automatisch, en is de margemodule
   (`sale_margin`) geïnstalleerd?** Bepaalt of marge per product kan of
   alleen op bedrijfsniveau (§1).
4. **Eén vennootschap of meerdere?** Consolidatie is een apart verhaal.
5. **Waar draait Odoo — Online, Odoo.sh, zelf gehost?** Bepaalt de
   export-timeout (§3.4) en of een read-only databasekopie ooit een optie is.
6. **Wie exporteert, en heeft die het exportrecht?** (§3.6; op Odoo 19
   standaard niet.)
7. **Zijn de kasstroomtags op de rekeningen gezet?** Zo ja: classificatie
   klaar. Zo nee: wij leiden ze af en hij corrigeert.
8. **Welke vaste verplichtingen zitten niet in Odoo?** Lonen, btw-afdrachten,
   huur, leningen — nodig voor het 13-weken plan, komen via een grid.
9. **Heeft hij al een kasstroomoverzicht of werkkapitaalsheet in Excel?**
   Dan is de indeling rekening → categorie al gemaakt, en het is meteen het
   tweede reconciliatiepunt.
10. **Welke vijf KPI's écht elke ochtend?** De mail noemt omzet, marge, cash,
    werkkapitaal, openstaande klanten. Als dat ze zijn, bouwen we daarop en
    laten we de rest weg.

---

## 8. Draaiboek van de showcase (in Clarion, in deze volgorde)

1. **Sources** — de Odoo-export-tegel, het `testConnection`-rapport: "17
   bestanden, 4 boekjaren, 214.000 boekingsregels, alle koppen herkend".
   Dit is het moment om te zeggen dat er geen API-koppeling nodig was.
2. **Catalog** — `account_move_line`: de vendor-beschrijvingen op elke
   kolom (curated, niet AI), de relaties "gelegd door de bron", de
   business key `id` "from Odoo". Eén klik naar het Relations-canvas: de
   afletteringsrelaties meten 100%.
3. **Build** — "Create my topics": Core dimensions / Finance / Sales /
   Purchasing / Inventory, deterministisch, in seconden. Topicpagina
   Finance: de vragen in de eerste persoon ("Wie is mij geld schuldig?").
4. **Reconciliatie** — het dashboard "Klopt het?": proefbalans, openstaande
   klanten en gemiddelde inningstermijn naast Odoo's eigen PDF's.
5. **Ask AI**, in het Nederlands, drie vragen die de mail letterlijk stelt:
   "Hoe evolueerde ons werkkapitaal per jaar sinds 2023?", "Welke klanten
   betalen structureel later dan afgesproken?", "Wat was onze brutomarge
   per kwartaal?" — met de glossary-adressen zichtbaar in "How I got this".
6. **Dashboards** — "CFO-overzicht" (de vijf KPI's), "Werkkapitaal" (saldi +
   DSO/DIO/DPO per jaar), "Kasstroom" (werking / investeringen /
   financiering per jaar, met de grid-mapping één klik verder).
7. **Your tables** — de kasstroom-mapping met dekkingsteller, en de vaste
   verplichtingen; laat Dries er live één toevoegen en het dashboard
   verspringen.
8. **13-weken plan** — de weekstaaf, met de aanname per klant zichtbaar.
9. **Pulse + ochtendbriefing** — DSO en openstaande klanten op de watchlist;
   uitleggen dat de briefing bij een maandelijkse her-upload één keer per
   maand iets te zeggen heeft, en dagelijks zodra de API-koppeling er is.
10. **Excel-add-in** — de saved question "openstaande klanten per
    vervalweek" in zijn eigen werkboek.

---

## 9. Bronnen

- Odoo exportcontroller: `addons/web/controllers/export.py` (17.0) —
  `get_fields` (import-compat verbergt readonly, `.id` alleen in gewone
  modus, labels als koppen, twee niveaus), `filename()`, CSV-writer.
- Veldattributen: `addons/account/models/account_move_line.py`,
  `account_move.py`, `account_partial_reconcile.py`, `account_payment.py`
  (17.0) — readonly-status per veld afgeleid uit `compute`/`inverse`/
  `related`/`readonly`.
- Waardeformaten: `odoo/fields.py` (`convert_to_export`),
  `odoo/tools/pycompat.py` (`csv_writer`).
- Kasstroomtags: `addons/account/data/account_data.xml` (17.0).
- Exportrecht: `odoo/addons/base/security/base_groups.xml` (17.0 en 19.0).
- Officiële docs (GitHub-mirror `odoo/documentation`, 17.0/18.0):
  `essentials/export_import_data.rst`, `finance/accounting/reporting.rst`
  (Executive Summary: "Average debtors days"), `get_started/chart_of_accounts.rst`.
- Clarion: `packages/connectors/src/odoo/package/**`, `odoo/catalog.ts`,
  `backend/src/services/starSchemaTemplates.ts`,
  `services/busMatrixOrchestrator.ts:252,261`, `csv/schema.ts`,
  `spreadsheet/{csvReader,xlsxReader,tabular}.ts`, `.ops/star-schema-design`,
  `docs/SOURCE_ONBOARDING.md` §7.
