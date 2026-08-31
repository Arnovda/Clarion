# Clarion vs Peliqan — capaciteitenvergelijking vanuit de eindgebruiker

**Datum:** 2026-08-31 · **Status:** onderzoeksdocument, geen code gewijzigd
**Vraag van de eigenaar:** wat kan Peliqan, wat kan Clarion, waar overlappen ze,
wat heeft de één wél en de ander niet — geredeneerd vanuit iemand die een
dataplatform *kiest*, niet vanuit iemand die er één bouwt.

---

## 0. Methode en eerlijkheid over de bronnen

**Clarion-kant: gemeten.** Alle claims over Clarion komen uit deze codebase
(routes, connectors, migraties), niet uit CLAUDE.md alleen. Waar een capaciteit
ontbreekt is dat geverifieerd met een repo-brede grep, niet aangenomen.

**Peliqan-kant: hun eigen marketing + reviews van derden, NIET gemeten.**
`peliqan.io` is in deze omgeving geblokkeerd door de egress-policy
(`EGRESS_BLOCKED` — een beleidsblokkade, geen netwerkfout; niet omzeild). Het
beeld is opgebouwd uit zoekresultaten die hun pagina's wél lezen, aangevuld met
G2/Capterra-reviews. **Dat betekent: hun featurelijst is wat zij zeggen dat ze
kunnen.** Ik heb geen enkele Peliqan-feature zien draaien. De G2-reviews zijn de
enige onafhankelijke bron in dit document, en die zijn hieronder zwaar gewogen —
juist omdat ze het enige zijn dat niet uit hun eigen mond komt.

Waar een claim van hen komt staat er *(claim)*. Waar iets gemeten is in deze
repo staat er *(gemeten)*.

---

## 1. De kern in vier zinnen

**Peliqan verkoopt de leidingen plus een activatielaag.** Ingest uit 250–300+
bronnen, een meegeleverd warehouse, transformeren in SQL/Python/spreadsheet, en
dan de data er weer *uit* — terug naar bedrijfsapplicaties, naar Excel, naar
data-apps, naar een MCP-endpoint voor AI-agents. De koper is iemand die data
*klaarzet* voor anderen.

**Clarion verkoopt begrip en vertrouwen in de antwoorden.** Eén bron aansluiten,
er automatisch een sterschema onder leggen, en dan is het hele product gebouwd
rond de vraag "kan ik dit antwoord geloven?" — herkomst, versheid, aannames,
geverifieerde antwoorden, een zelfcorrigerende antwoordlus. De koper is de
SMB-eigenaar of controller die het antwoord *gebruikt*.

Ze overlappen in het midden (beide: bronnen → warehouse → semantiek → vragen in
gewone taal → dashboards). Ze verschillen aan de uiteinden: Peliqan is veel
breder aan de *invoer*kant en heeft een hele *uitvoer*kant die Clarion helemaal
niet heeft. Clarion is veel dieper in de *begrip*-laag ertussen.

---

## 2. De reis van een eindgebruiker, stap voor stap

Zo ziet het eruit voor iemand die morgen wil beginnen. Dit is de belangrijkste
tabel van het document.

| Wat de gebruiker wil | Peliqan | Clarion |
|---|---|---|
| **Mijn systemen aansluiten** | 250–300+ connectoren; nieuwe op aanvraag in 5 werkdagen *(claim)* | **2 SaaS-connectoren (Exact Online, Odoo) + 4 directe databases** (Postgres, MySQL, SQL Server, SQLite) *(gemeten)* |
| **Mijn Excel-bestanden erbij** | Excel/SharePoint-connector, plus een Excel add-in om ánder werk in Excel te doen *(claim)* | **Geen enkele bestands-connector** *(gemeten: geen excel/csv/sheet-connector in `packages/connectors/src/`)*. Wel `/grids`: in-product spreadsheet met .xlsx-**upload** en gekoppelde kolommen |
| **Een warehouse hebben** | Ingebouwd, of je eigen (Snowflake/BigQuery/Fabric/…) *(claim)* | Ingebouwd (DuckDB + Delta/Parquet op Azure Blob), niet vervangbaar |
| **Data klaarzetten / modelleren** | SQL, low-code Python, spreadsheet-UI — jij doet het | **AI ontwerpt het sterschema zelf** (bus-matrix), of een deterministische, met de hand geschreven template per connector. Jij klikt "Create my topics" |
| **Een vraag stellen in gewone taal** | Ja, text-to-SQL met AI-assistent *(claim)* | Ja — en dit is het zwaartepunt van het product (zie §5) |
| **Weten of het antwoord klopt** | Data-quality checks, lineage, catalogus *(claim)* | Vertrouwensmarkering per antwoord, bron + versheid per antwoord, aannames als klikbare chips, reparatielus die zichzelf corrigeert, "★ Geverifieerd door je team" |
| **Een dashboard** | Eigen charts, óf je eigen BI-tool ernaast (Power BI, Tableau, Metabase) *(claim)* | AI genereert het volledige dashboard uit één zin; daarna aanpassen via chat |
| **Data terugschrijven naar mijn ERP/CRM** | Ja — reverse ETL, writeback per endpoint *(claim)* | **Nee. Nul.** *(gemeten: geen enkele hit op writeback/reverse-etl in de hele repo)* |
| **AI-agents op mijn data** | Eén MCP-endpoint, agents/chatbots/RAG op governed data *(claim)* | **Nee** *(gemeten: geen MCP-server, geen publieke API-sleutels)*. Alleen Clarion's eigen chat |
| **Een app/formulier bouwen op de data** | Streamlit-achtige data-apps in low-code Python *(claim)* | Notebooks (Python in de browser via Pyodide) — analyse, geen apps |
| **Delen met iemand buiten** | Embedding, white-label dashboards *(claim)* | **Nee** — geen externe deellinks, geen embedding |
| **Op mijn telefoon** | Niet gevonden | **Nee** |
| **In het Nederlands** | Niet gevonden (EU-focus wel) | UI is Engels (`lang="en"`), **maar antwoorden spiegelen de taal van de vraag** — Nederlands in, Nederlands uit |
| **Prijs** | €350/mnd (Starter, jaarlijks) → €500 Pro → €1500+ Enterprise, geteld per *connectie* *(claim)* | Nog geen prijsmodel. Kostenbasis ligt ordes lager (~€30–100/mnd infra, ~$1–2/mnd AI per tenant) |

---

## 3. Waar ze op elkaar lijken

Meer dan je zou denken. Beide zijn **all-in-one** — expliciet gepositioneerd
tegen "vijf tools aan elkaar knopen": ingest, warehouse, transformatie,
semantiek, vragen en visualisatie in één product. Beide mikken op **de
mid-market zonder data-engineer**. Beide leggen een **semantische/trust-laag**
tussen de ruwe bron en het antwoord, en beide noemen dat expliciet de reden dat
AI-antwoorden te vertrouwen zijn. Beide doen **text-to-SQL in gewone taal**.
Beide hebben **rollen, audit trail, kolommaskering en rijfilters**. Beide zijn
**EU-georiënteerd** en beide hebben **Exact Online en Odoo** — de twee ERP's die
in de Benelux het meest tellen.

Dat laatste is geen toeval, en het is het onderwerp van §6.

---

## 4. Wat Peliqan heeft en Clarion niet — gerangschikt op hoeveel het een koper uitmaakt

**1. Connectorbreedte. Dit is de grootste asymmetrie en alles hangt eraan.**
250–300+ tegen 6. Het belangrijkste dat een klant van een dataplatform wil — "de
vraag beantwoorden die mijn boekhouding alleen niet kan beantwoorden" — vereist
per definitie een tweede bron. Clarion's twee SaaS-connectoren zijn allebei
ERP's die geen SMB naast elkaar draait, dus in de praktijk heeft een Clarion-klant
vandaag één bron. Clarion's eigen `multi-source-strategy.md` noemt dit al als de
poort waar alles achter zit (P1: spreadsheet-connector als goedkoopste tweede
systeem). Peliqan verkoopt precies dat weg.

**2. De hele activatiekant: reverse ETL en writeback.** Data terugschrijven naar
Exact/HubSpot/Excel is bij Peliqan een kernfunctie met een writeback-matrix per
endpoint *(claim)*. Clarion heeft dit niet en het is ook nergens ontworpen.
Voor een gebruiker is het verschil concreet: bij Peliqan kan een opgeschoonde
klantenlijst terug de CRM in; bij Clarion kun je hem exporteren naar CSV.

**3. Eén MCP-endpoint voor AI-agents.** Peliqan verkoopt zichzelf inmiddels als
"de data-fundering waar je AI op kán handelen": externe agents (Claude, andere
clients) praten via één MCP-server met governed data, inclusief maskering en
row-level policies *(claim)*. Clarion's AI is *ingebouwd en gesloten* — er is
geen deur voor andermans AI. Dat is een strategische keuze die niemand
expliciet gemaakt heeft, en hij wordt elke maand duurder.

**4. Federated query over bronnen heen (Trino).** Peliqan bevraagt live over
bronnen heen zonder ze te verplaatsen *(claim)*. Clarion's query-laag is nog
steeds **connection-scoped** *(gemeten: `routes/query.ts` neemt één
`connectionId`)* — een vraag die twee bronnen kruist is er letterlijk niet in
uit te drukken. Dit staat al als P4 in de multi-source-strategie, en het is de
grootste architecturale schuld ten opzichte van deze concurrent.

**5. Data-apps en formulieren in low-code Python.** Bouw een invoerscherm, een
rapport, een intern toolt je in een paar regels *(claim)*. Clarion's notebooks
zijn analyse-omgevingen, geen app-platform.

**6. Externe distributie: embedding en white-label dashboards.** Voor
accountantskantoren en ISV's is dit vaak *de* reden om te kopen: het dashboard
draagt jouw logo, niet dat van de leverancier.

**7. SOC 2 Type II (en ISO 27001 in afronding)** *(claim)*. Clarion heeft de
techniek (RLS, per-tenant containers, encryptie, GDPR-purge, audit) maar geen
certificaat. Bij elke aanbesteding boven een bepaalde grootte is dat een
vinkje dat je hebt of niet hebt — techniek telt daar niet.

**8. Een prijskaartje op de website.** Klinkt triviaal, is het niet: het maakt
Peliqan koopbaar zonder gesprek.

---

## 5. Wat Clarion heeft en Peliqan niet — en waarom dat niet niks is

Hier keert de vergelijking om. Alles hierboven gaat over *breedte*. Dit gaat
over *diepte in de laag die de eindgebruiker daadwerkelijk aanraakt*.

**1. Het model wordt vóór jou ontworpen, niet dóór jou.** Peliqan geeft je een
spreadsheet, SQL en Python om je data te modelleren; het werk blijft van jou.
Clarion ontwerpt het sterschema zelf — via een deterministische, met de hand
geschreven template per connector waar die bestaat, en anders met AI — en de
gebruiker klikt één knop op `/build`. **Dit is het scherpste verschil in het
hele document**, want het is precies de klacht die uit Peliqan's eigen
G2-reviews komt: *steile leercurve, je hebt SQL- en Python-kennis nodig*. Dat is
geen mening van mij; dat zeggen hun eigen klanten. Clarion's hele bestaansrecht
zit in dat gat.

**2. Vertrouwen als product, niet als geruststelling.** Peliqan biedt de
standaardgereedschappen: kwaliteitschecks, lineage, catalogus. Clarion biedt iets
anders van aard — **per antwoord**: een categorische betrouwbaarheidsmarkering
(nooit een percentage voor een zakelijke gebruiker), de bron mét versheid van
*die specifieke tabellen*, de aannames als aanklikbare chips waarmee je het
antwoord vertakt, een reparatielus die een verdacht antwoord zelf nakijkt en
gecorrigeerd terugkomt, en "★ Geverifieerd door je team" zodra een mens het
goedkeurt. Dat is niet een betere catalogus; dat is een ander antwoord op
dezelfde vraag.

**3. Het werkblad-model in Ask AI.** Een vraag+antwoord is een *stap* met een
bevroren momentopname, stappen vormen een *boom*, je vertakt op een andere
aanname en vergelijkt. Geen enkel platform in dit segment doet dit, en het is
het directe antwoord op "de chat wordt onleesbaar lang".

**4. Proactief: de ochtendbriefing en pulse.** Clarion komt naar je toe. Peliqan
heeft Slack-alerts op datakwaliteit *(claim)* — dat is de pijplijn die piept,
niet het bedrijf dat rapporteert.

**5. De relatie-canvas met gemeten bewijs.** Relaties worden niet alleen
getekend, ze worden **tegen de data gemeten**, met onderscheid tussen "gelegd
door de bron" (documentatie van de leverancier, dus waar per definitie) en
"handmatig gelegd" (dus falsifieerbaar). Dat onderscheid heb ik nergens anders
gezien.

**6. Gekoppelde grids.** `/grids` is niet zomaar een spreadsheet: een kolom kan
**gekoppeld** zijn aan een kolom van een topic, met distinct-waarden als
dropdown en een dekkingsmeter ("42 van 57 gemapt · voeg de 15 ontbrekende toe").
Peliqan's spreadsheet-UI is rijker als *editor*; Clarion's grid is slimmer als
*mapping-instrument*.

**7. Per-tenant feature flags en release-treinen.** Eén schakelaar per release,
per klant. Operationeel volwassener dan je bij een product van deze leeftijd
verwacht.

**8. De kostenbasis.** ~€30–100/mnd infra plus ~$1–2/mnd AI per tenant. Peliqan
begint bij €350/mnd. **Het hele segment onder die drempel is voor Peliqan
onbereikbaar en voor Clarion wel bedienbaar** — en dat segment (de Belgische
KMO met één ERP en een boekhouder) is precies waar Clarion op mikt.

---

## 6. De onaangename bevinding: ze staan al op je erf

Dit is het stuk dat het meest telt en dat niet uit een featurelijst volgt.

Peliqan richt zich **expliciet op Benelux-accountantskantoren met tientallen
Exact Online-tenants**, met een "fan-out"-architectuur: per-tenant isolatie,
white-label dashboards en cross-tenant aggregatie zodat één prompt op
groepsniveau antwoord geeft *(claim)*. Ze publiceren een "Exact Online + Claude
CFO playbook", een Odoo-MCP voor Odoo-partners, en een Teamleader-integratie
voor Belgische KMO's *(claim)*.

Dat is niet "een aangrenzende markt". Dat is:
- dezelfde twee ERP's die Clarion heeft;
- dezelfde geografie;
- **hetzelfde kanaal** — het accountantskantoor — dat in
  `warehouse-value-for-smb.md` §2.4 als Clarion's kanaalstrategie staat
  beschreven, inclusief de "tier boven de tenant" die daar nog *gepland* is en
  bij hen kennelijk al *verkocht* wordt.

Twee dingen volgen daaruit, en ze wijzen niet dezelfde kant op.

**(a) De timing van de portfolio-tier is dringender geworden.** G12 in de
gap-analyse ("portfolio-tier voor de accountant") stond ver achteraan. Als de
concurrent dat kanaal nu al met naam en toenaam bewerkt, is de vraag niet meer
of het gebouwd wordt maar of het gebouwd wordt vóór het kanaal bezet is.

**(b) Maar níét door hen achterna te lopen.** Op breedte verliest Clarion — 6
tegen 300 connectoren haal je niet in, en dat hoeft ook niet. Peliqan's eigen
klanten zeggen dat het product technische kennis vereist. Dat is een structurele
eigenschap van wat ze verkopen (SQL + Python + spreadsheet = jij modelleert),
niet een bug die ze volgend kwartaal wegpoetsen. **Clarion wint alleen op het
tegenovergestelde: de gebruiker die géén SQL kan, krijgt bij Clarion een
kloppend model zonder het zelf te ontwerpen, en een antwoord waarvan het product
zelf zegt hoe zeker het is.** Elke roadmapkeuze die die belofte verwatert om
breedte bij te benen, ruilt het enige gewonnen terrein in voor terrein waar de
tegenstander al staat.

---

## 7. Wat dit concreet betekent voor de volgorde van bouwen

Dit herordent de bestaande gap-analyse; het vervangt hem niet.

**Onmiddellijk, omdat het bestaand werk waardeloos maakt zolang het ontbreekt:**
1. **Een tweede bron die iedereen heeft** — de spreadsheet/Excel-connector (P1
   in de multi-source-strategie). Zonder tweede bron is "cross-systeem" een
   belofte die het product niet kan waarmaken, en dat is de belofte waarop dit
   hele segment koopt. Dit is de goedkoopste tweede bron die bestaat.
2. **De query-laag ontkoppelen van de connectie** (P4). Zolang een vraag maar
   één bron mag raken, is elke extra connector half werk.

**Kort daarna, omdat het de deur is die nu dichtzit:**
3. **Een MCP-endpoint of publieke API.** Niet om Peliqan na te doen, maar omdat
   Clarion's semantische laag + policies precies het soort ding is waar een
   externe agent iets aan heeft — en omdat "onze data is bereikbaar voor de AI
   die de klant zelf al gebruikt" binnen een jaar een aankoopcriterium is.
4. **Externe deellinks / een white-label-laag**, want dat is wat het
   accountantskanaal koopt.

**Bewust NIET doen:**
- Geen jacht op connector-aantallen. 300 connectoren bouwen is een ander bedrijf.
- Geen reverse ETL/writeback nu. Het is een compleet andere risicoklasse (je
  schrijft in het boekhoudsysteem van een klant) en het is niet waar Clarion's
  belofte over gaat.
- Geen low-code app-platform. Notebooks volstaan; app-bouwers zijn niet de
  gebruiker die Clarion bedient.
- Niet de vertrouwenslaag verdunnen om sneller breedte te halen. Dat is het enige
  wat de concurrent niet heeft.

**Wél alvast regelen, want het is een vinkje en geen feature:** de weg naar
SOC 2 Type II. Techniek is er; het certificaat niet, en dat kost doorlooptijd
die je niet kunt inhalen op het moment dat een prospect ernaar vraagt.

---

## 8. Wat ik niet heb kunnen vaststellen

Eerlijk, zodat niemand dit document zwaarder leest dan het is:
- **Geen enkele Peliqan-feature is geverifieerd.** `peliqan.io` is geblokkeerd
  in deze omgeving; alles met *(claim)* komt van hun marketing via
  zoekresultaten.
- **Geen prijsvergelijking mogelijk** aan Clarion's kant — er is geen prijsmodel.
- **Onbekend hoe goed hun text-to-SQL is.** Dat is precies het terrein waarop
  Clarion zou moeten winnen, en het is niet gemeten. Een echte proef (dezelfde
  Exact Online-dataset, dezelfde tien vragen, beide producten) zou meer waard
  zijn dan dit hele document.
- **Onbekend of hun "300+ connectoren" diep of ondiep zijn.** Het verschil tussen
  een connector die een tabel ophaalt en één die het datamodel van de leverancier
  kent (zoals Clarion's 61 gedocumenteerde Exact Online-entiteiten met 2.613
  gedocumenteerde kolommen) is enorm, en telt niet mee in een aantal.

---

## Bronnen

Peliqan (marketing, via zoekresultaten — peliqan.io was niet direct bereikbaar):
homepage "The trust layer for AI & BI", `/platform/`, `/pricing/`,
`/saas-data-cockpit/`, `/finance-consultants/`, `/security/`,
`/data-onboarding-for-saas-companies/`, `/blog/exact-online-claude/`,
`/blog/build-mcp-server/`, `/blog/vibe-coding-with-peliqan/`,
`/blog/reverse-etl-tools/`, `help.peliqan.io`.
Onafhankelijk: G2 (reviews + pros/cons), Capterra, SoftwareReviews, Toolradar.

Clarion: deze codebase op `claude/clarion-peliqan-comparison-v00nvs`
(`packages/connectors/src/`, `backend/src/routes/`, `backend/src/db/migrations/`,
`frontend/app/`), plus `docs/backlog/multi-source-strategy.md`,
`functionality-gap-analysis.md`, `warehouse-value-for-smb.md`.
