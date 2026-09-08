# Odoo via ruwe tabellen — is Clarion hier klaar voor?

**Status:** assessment, 2026-09-08. Geen productcode gewijzigd.
**Aanleiding:** mail van Dries Martens (Neopaul, 2026-06-05) — eerste
potentiële testklant. Draait Odoo. Wil **de ruwe tabellen aanleveren**, niet
(voorlopig) via onze Odoo-connector.

Elke claim hieronder is tegen deze codebase geverifieerd, met `file:line`.

---

## 1. Wat Dries vraagt

Uit de mail, zes deliverables:

1. **Kasstroomoverzicht** laatste 2–3 jaar, gesplitst werking / investeringen /
   financiering.
2. **Evolutie werkkapitaal**: klanten-, voorraad- en leverancierssaldi, met
   gemiddelde inningstermijn (DSO), voorraadtermijn (DIO) en betaaltermijn aan
   leveranciers (DPO), jaar per jaar.
3. **Rollende 13-weken kasplanning.**
4. **Managementrapportering** met een beperkt aantal KPI's (omzet, marge, cash,
   werkkapitaal, openstaande klanten).
5. **Margeanalyse.**
6. **Actieve opvolging werkkapitaal**: DSO, betaaltermijnen, oplopende voorraad.

Dit is een klassiek CFO-pakket. Vier van de zes zijn *balansgedreven*, niet
*stroomgedreven* — dat is de rode draad in wat hieronder wel en niet past.

---

## 2. Oordeel

**Ja, met één harde grens en twee echte gaten.**

| # | Vraag | Kan Clarion dit vandaag | Wat het kost |
|---|---|---|---|
| 1 | Kasstroomoverzicht | **Ja, mits mapping** | Mappingtabel GL-rekening → kasstroomcategorie. Het primitief bestaat (`managed grids`). |
| 2 | Werkkapitaal + DSO/DIO/DPO | **Ja** | Export moet `date_maturity` + `amount_residual` bevatten (zie §5). |
| 3 | Rollende 13-weken kasplanning | **Nee, niet out of the box** | Echt bouwwerk. Zie §4.2. |
| 4 | Managementrapportering | **Ja — sterkste kant** | Dashboards + pulse + ochtendbriefing bestaan. |
| 5 | Margeanalyse | **Half** | Omzet zit erin, **kostprijs niet**. Zie §4.3. |
| 6 | Opvolging werkkapitaal | **Ja** | Pulse-watchlist + quality alerts. |

---

## 3. De drie beslissingen die nú genomen moeten worden

### 3.1 Eén Excel-werkboek, niet losse CSV's

Dit is de belangrijkste bevinding en ze is niet-evident.

* De CSV-connector is **één bestand = één tabel = één connectie**
  (`packages/connectors/src/csv/CsvConnector.ts:11` — *"one entity, because one
  file is one table"*).
* De Excel-connector is **één werkboek = één connectie, één tab = één tabel**
  (`packages/connectors/src/excel/ExcelConnector.ts:10`).
* Het sterschema-ontwerp (`bus-matrix`) laadt brontabellen **per connectie**:
  `.where({ 'st.connection_id': connectionId, 'st.is_active': true })`
  (`backend/src/services/busMatrixOrchestrator.ts:238`).

Gevolg: **tien CSV's worden tien aparte bronnen, en de ontwerper ziet er per
build precies één tabel.** Je krijgt tien losse "topics" van elk één tabel, geen
enkele join. Precies wat je niet wil.

Eén werkboek met een tab per Odoo-tabel geeft de ontwerper alle tabellen
tegelijk, met hun relaties, en levert één samenhangend sterschema.

**Tabbladnamen worden tabelnamen** (`sanitiseEntityName`,
`packages/connectors/src/spreadsheet/tabular.ts:272`) en **kolomkoppen worden
kolomnamen** (`sanitiseIdentifier`, `:84`). Dus: noem de tabs exact
`account_move_line`, `account_move`, … en exporteer met de technische
kolomnamen van Odoo, niet met de Nederlandse schermlabels.

### 3.2 Het 15 MB-plafond is de echte grens

* `MAX_FILE_BYTES = 15 * 1024 * 1024` in beide bestandsconnectoren
  (`packages/connectors/src/excel/schema.ts:36`, `csv/schema.ts:20`). Het
  bestand rijdt base64 mee in de connectorconfig; de uploadroute staat 32 MB
  body toe (`backend/src/index.ts:140`).
* De rijlimiet is **250.000 rijen / 256 kolommen** per tab
  (`spreadsheet/xlsxReader.ts:65-66`) — die haal je bijna nooit vóór de 15 MB.
* Boven de limiet volgt een **harde weigering, geen halve tabel**:
  `assertSheetComplete` gooit `SheetTooLargeError` en er wordt niets geschreven
  (`spreadsheet/tabular.ts:244`). Bewust: een afgekapte tabel ziet er compleet
  uit en beantwoordt vragen met verkeerde cijfers.

`account_move_line` over drie jaar is de tabel die dit gaat breken. Ruwe orde
van grootte: ~15 kolommen ≈ 200 byte per rij → ~75.000 rijen als platte CSV.
Een xlsx comprimeert (zip), dus ruimer, maar niet oneindig.

**Als het niet past: niet splitsen.** Splitsen per jaar over losse bestanden
geeft opnieuw het probleem van §3.1, en splitsen over tabs geeft
`account_move_line_2024` / `_2025` als aparte tabellen die de ontwerper niet
vanzelf samenneemt. De juiste uitweg is §3.3.

### 3.3 De uitweg bij volume: een read-only Postgres-kopie

Odoo draait op PostgreSQL, en **Clarion heeft een werkende Postgres-brontegel**
(`frontend/app/sources/page.tsx:144` — `available: true`;
`backend/src/connectors/ConnectorFactory.ts:56`). Geen volumelimiet, echte
integer-FK's, exacte kolomnamen, en herhaalbaar zonder handmatige export.

Kanttekening, eerlijk: die route loopt via het **oudere ETL-ingestiepad**
(`backend/src/routes/ingestion.ts` → de Python ETL-service), niet via de
nieuwere connector-framework-sync. Het pad bestaat en de tabelcatalogus
ondersteunt beide, maar het is de laatste maanden minder gereden dan de
connector-sync. **Dit moet één keer end-to-end getest worden vóór je het aan
een klant belooft.**

### 3.4 De Odoo-template wordt niet gebruikt — en dat is jammer

Clarion heeft een hand-geschreven, tegen echte DuckDB getest Odoo-sterschema:
9 conforme dimensies, 6 facts, 5 KPI's, 33 relaties
(`packages/connectors/src/odoo/starSchemaTemplate.ts`).

Die wordt hier **niet toegepast**, om twee onafhankelijke redenen:

1. `tryBuildBusMatrixFromTemplate` kiest de template op **`connectorType`**
   (`backend/src/services/starSchemaTemplates.ts:117-131`). Een bestandsbron is
   type `excel`/`csv`, dus de Odoo-template komt niet in beeld — ook al zijn de
   tabellen letterlijk Odoo-tabellen met Odoo-namen.
2. `.ops/star-schema-design` staat sinds 2026-08-18 op **`ai`**, wat
   `STAR_SCHEMA_TEMPLATES_DISABLED=1` zet. Templates staan dus sowieso overal
   uit.

Gevolg: de **AI ontwerpt** het sterschema. Dat werkt, maar het kost tokens en
minuten per build, en de naamgeving is niet deterministisch tussen tenants.

**Kleine, concrete verbetering als dit de eerste klant wordt:** laat een
bestandsbron een template *lenen* — bijvoorbeeld een veld "deze tabellen komen
uit Odoo" in de wizard, dat `tryBuildBusMatrixFromTemplate` een expliciete
`connectorType` meegeeft in plaats van die van de connectie. Dat is een klein
stuk werk (één parameter, één wizard-veld) en zou hier meteen renderen: je
krijgt exact het sterschema dat al getest is, zonder AI-kosten. Los daarvan
moet `.ops/star-schema-design` dan terug naar `templates`.

---

## 4. De inhoudelijke gaten

### 4.1 Balanscijfers zijn afleidbaar, maar niet gemodelleerd

Het hele verhaal van Dries (kasstroom, werkkapitaal, DSO/DIO/DPO) is
**saldogedreven**: je hebt de stand van klanten/voorraad/leveranciers op een
datum nodig, niet de mutaties.

Clarion's facts zijn transactiefacts. `fact_journal_items` draagt
`debit` / `credit` / `balance` en joint op `dim_account` met `account_type`
(`odoo/starSchemaTemplate.ts:311-350`, `:150`). Een saldo per datum is dus
uitdrukbaar — `SUM(balance) WHERE entry_date <= X` — maar dat is een
lopende-som-patroon dat de AI bij élke vraag opnieuw moet schrijven.

Dat is precies het soort vraag waar een verkeerd antwoord er plausibel uitziet.
**Aanbeveling:** één maandelijkse saldosnapshot-tabel per rekening
(`account_id`, `maand`, `eindsaldo`) als eerste eigen product. Daarmee worden
kasstroom, werkkapitaal en DSO/DIO/DPO alle vier triviale queries in plaats van
vier keer dezelfde subtiele SQL.

Odoo's `account_type` (`asset_receivable`, `liability_payable`, `asset_fixed`,
`income`, `expense`, …) doet daarbij het meeste werk gratis — mits die kolom in
de export zit.

### 4.2 De 13-weken kasplanning is een echt gat

`POST /api/query/forecast` bestaat (`backend/src/routes/query.ts:2211`) maar de
motor is **lineaire regressie of voortschrijdend gemiddelde**
(`backend/src/services/forecastEngine.ts:3, :196-200`) — hij extrapoleert een
historische reeks.

Een rollende 13-weken kasplanning is iets anders: een **deterministische
roll-forward van openstaande posten op vervaldatum** — openstaande klanten per
vervalweek, openstaande leveranciers per vervalweek, plus vaste verplichtingen
(lonen, huur, btw, leningen). Statistiek komt er niet aan te pas.

Het is bouwbaar op wat er is (een dashboard of notebook over open AR/AP met
`date_maturity` en `amount_residual`), maar het is **bouwwerk, geen
configuratie**. Onderschat dit niet in de belofte aan Dries. De vaste
verplichtingen zijn bovendien deels *niet* in Odoo aanwezig en horen in een
managed grid.

### 4.3 Margeanalyse mist de kostprijs

`fact_invoice_lines` draagt omzet. **Kostprijs zit er niet in.** Drie mogelijke
bronnen, in volgorde van kwaliteit:

1. `stock.valuation.layer` — echte COGS per beweging (`unit_cost`, `value`).
   Staat in de allowlist (`odoo/entities.ts`) maar is **afwezig op sommige
   Odoo-versies** (verwijderd in v19) en alleen gevuld bij automatische
   voorraadwaardering.
2. `sale.order.line.purchase_price` — het margeveld van Odoo's margin-module,
   alleen aanwezig als die module aanstaat.
3. `product.template.standard_price` — huidige kostprijs, geen historiek. De
   zwakste: marges van vorig jaar herrekend tegen de kostprijs van vandaag.

**Dit moet je expliciet met Dries uitklaren vóór de export.** Als geen van de
drie beschikbaar is, is "margeanalyse" niet leverbaar en moet dat nu gezegd
worden, niet na de eerste demo.

### 4.4 Geen waterfall-widget

Kasstroomoverzichten willen een waterfall. De beschikbare widgets zijn
kpi_card, bar/line/stacked_bar/pie, combo, pivot_table, data_table, scatter,
bullet, treemap, radar (`backend/src/shared/widgetContracts.ts:23-36`). Een
gestapelde staaf of een tabel doet het werk; een waterfall is een aparte,
kleine toevoeging.

---

## 5. Wat je van Dries nodig hebt

### 5.1 De exportlijst

Onderstaande tabellen, met **de technische kolomnamen van Odoo** en **de
numerieke id's van relatievelden** (zie §5.2). Volgorde = prioriteit.

**Kern — hieruit komen kasstroom, werkkapitaal, DSO/DIO/DPO en de P&L:**

| Odoo-model | Tab / tabelnaam | Kolommen |
|---|---|---|
| `account.move.line` | `account_move_line` | `id, move_id, date, date_maturity, account_id, partner_id, journal_id, company_id, currency_id, name, debit, credit, balance, amount_residual, amount_currency, reconciled, full_reconcile_id, product_id, quantity, price_unit, price_subtotal, display_type, parent_state` |
| `account.move` | `account_move` | `id, name, ref, move_type, state, date, invoice_date, invoice_date_due, partner_id, journal_id, company_id, currency_id, amount_untaxed, amount_tax, amount_total, amount_residual, payment_state, invoice_origin, invoice_payment_term_id` |
| `account.account` | `account_account` | `id, code, name, account_type, reconcile, company_id` |
| `account.journal` | `account_journal` | `id, name, code, type, company_id` |
| `res.partner` | `res_partner` | `id, name, vat, is_company, parent_id, customer_rank, supplier_rank, country_id, property_payment_term_id, property_supplier_payment_term_id` |
| `account.payment.term` | `account_payment_term` | `id, name` |
| `res.company` | `res_company` | `id, name, currency_id` |

`date_maturity` en `amount_residual` zijn **niet optioneel**: zonder die twee is
er geen DSO, geen ouderdomsanalyse en geen 13-weken plan.

**Voor marge en voorraad:**

| Odoo-model | Tab / tabelnaam | Kolommen |
|---|---|---|
| `product.product` | `product_product` | `id, product_tmpl_id, default_code, barcode, active` |
| `product.template` | `product_template` | `id, name, categ_id, type, list_price, standard_price, uom_id` |
| `product.category` | `product_category` | `id, name, complete_name, parent_id` |
| `stock.valuation.layer` | `stock_valuation_layer` | `id, create_date, product_id, quantity, unit_cost, value, remaining_qty, remaining_value, stock_move_id, account_move_id, company_id` |
| `stock.quant` | `stock_quant` | `id, product_id, location_id, quantity, reserved_quantity` |

**Voor de vooruitblik (13-weken plan, orderboek):**

| Odoo-model | Tab / tabelnaam | Kolommen |
|---|---|---|
| `sale.order` | `sale_order` | `id, name, partner_id, date_order, commitment_date, state, amount_untaxed, amount_total, invoice_status, company_id` |
| `sale.order.line` | `sale_order_line` | `id, order_id, product_id, product_uom_qty, qty_delivered, qty_invoiced, price_unit, price_subtotal, purchase_price` |
| `purchase.order` | `purchase_order` | `id, name, partner_id, date_order, date_planned, state, amount_untaxed, amount_total, invoice_status, company_id` |
| `purchase.order.line` | `purchase_order_line` | `id, order_id, product_id, product_qty, qty_received, qty_invoiced, price_unit, price_subtotal` |
| `account.payment` | `account_payment` | `id, name, date, amount, payment_type, partner_type, partner_id, journal_id, state, move_id, currency_id` |

**Filters op de export:** boekjaren vanaf 1 januari drie jaar terug, en voor
`account_move_line` alleen `parent_state = 'posted'` (of neem de kolom mee en
filter later — maar dan telt hij mee voor de 15 MB).

### 5.2 De valkuil die alles stil kapotmaakt

**Odoo's UI-export schrijft relatievelden weg als schermnaam, niet als id.**
`account_id` wordt dan `"400000 Handelsdebiteuren"` in plaats van `42`. Elke
join breekt, en hij breekt *stil* — je krijgt geen fout, je krijgt minder rijen.

Twee manieren om dat te voorkomen:

1. In het exportvenster **"Ik wil gegevens bijwerken (import-compatibele
   export)"** aanvinken. Relatievelden komen dan als externe id's.
2. **Beter: exporteren uit de database** (`COPY (SELECT …) TO STDOUT WITH CSV
   HEADER`). Dan zijn het gewoon integers, met de exacte Odoo-kolomnamen, en is
   er geen volumeprobleem. Zie §3.3.

### 5.3 De vragen die je Dries moet stellen

1. **Waar draait Odoo** — Odoo Online, Odoo.sh, of zelf gehost? Dat bepaalt of
   een database-kopie überhaupt kan (Online: alleen een backup-download;
   Odoo.sh en self-hosted: ja).
2. **Welke Odoo-versie?** Bepaalt of `stock.valuation.layer` bestaat.
3. **Staat automatische voorraadwaardering aan?** Zo nee: geen echte COGS →
   §4.3.
4. **Eén vennootschap of meerdere?** `company_id` staat overal in; consolidatie
   is een apart verhaal.
5. **Hoeveel boekingsregels per jaar?** Eén getal
   (`SELECT count(*) FROM account_move_line WHERE date >= '2023-01-01'`)
   beslist tussen Excel-upload en Postgres-kopie. **Vraag dit eerst** — het is
   goedkoop en het stuurt al het andere.
6. **Welke vaste verplichtingen zitten níét in Odoo?** Lonen, leningen,
   btw-afdrachten, huur. Die horen in het 13-weken plan en moeten via een
   managed grid binnenkomen.
7. **Heeft hij een bestaand kasstroomoverzicht?** Zo ja: dat is de mapping van
   GL-rekening naar categorie, al gemaakt. Vraag het als spreadsheet — het
   scheelt de moeilijkste stap.

---

## 6. Wat wél al af is en hier direct rendeert

* **Managed grids ("Your tables")** — de mappingtabel GL-rekening →
  kasstroomcategorie hoort hier. Gekoppelde kolommen tegen een echte
  dimensiekolom, een dekkingsindicator ("42 van de 57 rekeningen toegewezen") en
  één klik om de ontbrekende toe te voegen. Grids worden als
  `grid_<slug>`-views geregistreerd in elke product-sessie
  (`backend/src/connectors/ConnectorFactory.ts:201`) en het model krijgt de
  join-hint mee (`productContext.ts:391`). Dit is exact het primitief dat een
  kasstroomoverzicht nodig heeft, en het bestaat.
* **Cross-source vragen** (2026-09-07) — als er tóch meerdere bronnen komen,
  kunnen vragen die overspannen, met de botsingsregel die een dubbelzinnige
  tabelnaam weigert in plaats van de verkeerde te kiezen.
* **Managementrapportering** — dashboards, pulse-watchlist, ochtendbriefing met
  de nachtelijke oorzaakanalyse. Dit is de sterkste kant van het platform en
  dekt punt 4 en 6 van Dries.
* **Excel-add-in** — voor een CFO die toch in Excel eindigt.

---

## 7. Aanbevolen volgorde

1. **Stel vraag 5 uit §5.3** (aantal boekingsregels). Eén getal, beslist de rest.
2. Vraag de export volgens §5.1, als **één Excel-werkboek**, tabs exact benoemd.
3. Test het legacy-Postgres-pad één keer end-to-end (§3.3) zodat de uitweg
   bewezen is voordat je hem nodig hebt.
4. Bouw de **maandelijkse saldosnapshot** (§4.1) als eerste eigen product.
5. Kasstroommapping in een managed grid, samen met Dries' bestaande overzicht.
6. Pas dán het 13-weken plan (§4.2) — het is het duurste stuk en het leunt op
   alle voorgaande.

**Niet beloven vóór §5.3 beantwoord is:** margeanalyse (hangt aan COGS) en de
13-weken kasplanning (bestaat niet, moet gebouwd).
