# Eén MCP-endpoint (Peliqan) vs. AI ín het platform (Clarion)

**Datum:** 2026-09-01 · **Status:** onderzoeksdocument, geen code gewijzigd
**Vraag van de eigenaar:** wat vind je van het ene MCP-endpoint dat Peliqan
vooruitschuift, tegenover onze aanpak om de AI ín het platform te hebben voor
alles? Voor- en nadelen, kosten, en heeft Clarion de juiste keuze gemaakt?

Vervolg op `clarion-vs-peliqan.md` (2026-08-31). Dat document behandelde MCP in
één alinea als "punt 3 van wat zij hebben en wij niet". Deze vraag verdient meer,
omdat het antwoord anders is dan het lijkt.

---

## 0. Methode

**Clarion-kant: gemeten in deze codebase.** Elk cijfer hieronder komt uit
routes, services, migraties — niet uit CLAUDE.md.

**Peliqan-kant: hun marketing + zoekresultaten, NIET gemeten.** `peliqan.io` is
nog steeds geblokkeerd door de egress-policy van deze omgeving
(`EGRESS_BLOCKED`, opnieuw geprobeerd op 2026-09-01, niet omzeild). Wat hier
staat komt uit zoekresultaten die hun pagina's lezen. *(claim)* betekent: dat
zeggen zij.

**Marktkant: zoekresultaten van september 2026**, aangegeven als *(markt)*. Geen
enkele daarvan is door mij geverifieerd tegen een draaiend product.

---

## 1. Het korte antwoord

**De vraag stelt twee dingen tegenover elkaar die op verschillende lagen zitten.**
MCP is een *transportlaag* — een deur waardoor andermans agent bij jouw data kan.
AI-in-het-platform is een *productervaring* — de kamer achter die deur. Ze
concurreren niet; ze stapelen.

Het bewijs daarvoor is dat de serieuze spelers allebei doen. Snowflake heeft
Cortex Analyst (in-product NL-antwoorden) **én** een MCP-server; Databricks heeft
Genie **én** een MCP-server; dbt, Cube en AtScale leveren allemaal een MCP-server
bovenop hun semantische laag *(markt)*. De formulering die in de markt is blijven
hangen: *"MCP provides the transport; the semantic layer provides the
knowledge."*

Dus:

- **Clarion heeft de juiste kamer gebouwd.** De semantische + vertrouwenslaag is
  het schaarse deel. Het sterkste bewijs is dat Peliqan zichzelf inmiddels **"the
  trust layer for AI & BI"** noemt *(claim, hun eigen homepage-titel in de
  zoekresultaten van september 2026)* — hun positionering beweegt naar die van
  Clarion, niet andersom. In augustus verkochten ze nog leidingen plus activatie.
- **Clarion mist de deur, en dat is een echt gemis** — maar het is een gemis van
  dagen werk, niet van maanden, want 90% van wat een MCP-endpoint nodig heeft
  staat al in de repo (§5).
- **"Alleen MCP" zou voor Clarion fataal zijn geweest** en is voor Peliqan
  logisch, om exact dezelfde reden: MCP maakt van je product een *bron*. Als je
  waarde breedte is (300 bronnen) is bron-zijn geweldig. Als je waarde begrip is
  (6 bronnen, maar je begrijpt ze), is bron-zijn precies het weggeven van je
  differentiator.

---

## 2. Wat het ene MCP-endpoint echt is

Zoals Peliqan het verkoopt: één gehoste MCP-server die 300+ zakelijke bronnen
afdekt, met een governance-laag ertussen — kolommaskering, row-level toegang,
audit logging — plus SOC 2 Type II *(claim)*. Hun eigen framing: *"je AI krijgt
een scoped key, nooit je wachtwoorden, en je kunt elke tool met één klik
intrekken"* *(claim)*.

Waarom dat sterk is voor hén: de moeilijkste belofte van een MCP-endpoint is
*breedte* — één deur naar alles. Dat is letterlijk wat ze al hadden. Hun MCP is
geen nieuw product, het is een tweede uitgang op dezelfde pijp. De marginale
bouwkosten waren laag en de marketingwaarde hoog.

En de markt zit mee: MCP is in januari 2026 ondergebracht bij de Agentic AI
Foundation als leveranciersneutrale standaard *(markt)*. Het is geen weddenschap
meer op één leverancier.

---

## 3. Voordelen van de MCP-aanpak (wat Clarion vandaag misloopt)

**1. Distributie — en dit is verreweg het belangrijkste.** De gebruiker zit al in
Claude, ChatGPT of Copilot. Een MCP-endpoint zet jouw data in het venster waar
iemand al werkt, in plaats van te vragen naar een ander tabblad te komen. Voor
Clarion, dat vandaag nul externe deuren heeft, is dat geen feature maar een
acquisitiekanaal.

**2. De tokens worden door de klant betaald.** Bij in-platform AI betaalt Clarion
élke token (§6). Bij MCP betaalt de klant ze via zijn eigen abonnement, en
Clarion betaalt alleen de DuckDB-uitvoering — praktisch nul. De brutomarge per
antwoord gaat van "iets" naar "bijna alles".

**3. Combineerbaarheid.** Een agent kan het antwoord van Clarion combineren met
mail, agenda, een CRM of een spreadsheet in één taak. Clarion's ingebouwde chat
kan dat per definitie nooit, want die kent alleen Clarion.

**4. Je bent niet meer je eigen UI-flessenhals.** Elke nieuwe manier om de data te
gebruiken hoeft niet eerst als scherm gebouwd te worden.

**5. Het is de kant waar de markt op loopt.** 67% van de CTO's noemt MCP hun
standaard voor agent-integratie binnen twaalf maanden *(markt, hun cijfer, niet
geverifieerd)*. De richting is in elk geval onmiskenbaar: elke semantische laag
van betekenis levert er inmiddels één.

---

## 4. Nadelen — waarom "alleen MCP" voor Clarion het product zou opheffen

**1. Het bewijsmateriaal reist niet mee, tenzij je het expliciet meestuurt.**
Clarion's differentiator is geen antwoord, het is een *rendering*: de
vertrouwensregel, "★ Geverifieerd door je team", bron + versheid per antwoord,
aannames als klikbare chips, de reparatielus die zichzelf corrigeert. Over MCP
gaat er tekst naar iemands agent, die hem mag samenvatten, negeren of
overschrijven. **Dit is oplosbaar en het is de belangrijkste ontwerpeis van
§7:** het `done`-payload van `/query/think` bevat vandaag al precies de juiste
velden — `verified`, `sources`, `confidence`, `policyNotice`, `tablesUsed`,
`answeredInMs` *(gemeten, `routes/query.ts:1355`)*. Die horen gestructureerd in
het MCP-antwoord, niet in proza.

**2. Geverifieerde antwoorden zijn omzeilbaar.** `findVerifiedQuestion` matcht op
een genormaliseerde **exacte** vraagtekst *(gemeten,
`services/savedQuestions.ts`)*. Een agent herformuleert een vraag zonder erbij
na te denken, mist de match, en valt terug op generatie — precies het pad dat de
menselijke verificatie moest vervangen. De trustlaag verzwakt door
herformulering.

**3. Je wordt een commodity-bron.** Als de intelligentie in de agent zit, ben jij
"een tabel met governance". Voor Peliqan is dat prima — hun waarde is dat er 300
van die tabellen zijn. Voor Clarion is het het weggeven van de enige reden om
Clarion te kiezen.

**4. Je verliest je feedbackloop.** `query_log`, `definition_gaps`, de
duim-omlaag → curatie → "Fix & verify"-lus, `saved_questions.times_used`: het
curatievliegwiel van Clarion draait op geobserveerd gebruik *(gemeten)*. Vragen
die via een externe agent binnenkomen zijn nog steeds te loggen, maar wat de
gebruiker met het antwoord dééd — accepteerde, corrigeerde, doorvroeg — zie je
niet meer.

**5. Een MCP-deur is een nieuwe risicoklasse, geen nieuwe route.** Tool poisoning,
indirecte prompt-injectie en exfiltratie zijn in 2026 gedocumenteerde,
uitgevoerde aanvallen, niet theorie: een team van Johns Hopkins kaapte Claude
Code, Gemini CLI en GitHub Copilot via instructies verstopt in PR-titels en liet
ze secrets exfiltreren; bij Supabase's Cursor-agent werd via een support-ticket
SQL binnengesmokkeld die integratietokens uitlas *(markt)*. Het patroon is
telkens hetzelfde: de agent leest onbetrouwbare inhoud en handelt ernaar, namens
een gebruiker met echte rechten. **Clarion's bestaande verdediging past hier
goed op** — `assertSafeReadQuery` (SELECT-only, geen externe toegang),
`applyDataPolicies` op run time, tokens die nooit boven hun eigenaar uitkomen —
maar dat is een reden om de deur smal te bouwen, niet een reden om te denken dat
het risico er niet is.

**6. Het lost het echte tekort niet op.** Een agent die één bron kan bevragen is
even beperkt als een chat die één bron kan bevragen. Clarion's query-laag is nog
steeds connection-scoped *(gemeten: `routes/query.ts:370` neemt één
`connectionId`)*. MCP vergroot je *bereik*, niet je *antwoordvermogen*.

---

## 5. Wat een MCP-endpoint Clarion zou kosten om te bouwen — gemeten

Dit is de verrassing van dit onderzoek, en het is de reden dat de kosten-baten
scheef in het voordeel van bouwen uitvalt. **Het meeste staat er al:**

| Wat een MCP-server nodig heeft | Bestaat in Clarion? |
|---|---|
| Machine-authenticatie zonder browsersessie | **Ja** — `api_tokens` + `services/apiTokens.ts`: SHA-256 hash, rol en tenant live uit de `users`-rij, dus een token overleeft een rolwijziging niet *(gemeten)* |
| Een middleware die zo'n token inwisselt | **Ja** — `middleware/apiToken.ts` wisselt hem om voor een kortlevende JWT en stapt opzij, zodat `requireAuth` ongewijzigd draait *(gemeten)* |
| Een smal, read-only oppervlak als patroon | **Ja** — `routes/addin.ts`, drie endpoints, geen enkele mutatieroute. De kopcommentaar noemt MCP letterlijk "the obvious next caller" *(gemeten)* |
| Beleid dat op uitvoertijd toegepast wordt | **Ja** — `applyDataPolicies` (rijfilters + kolommaskering) draait op alle vijf de querypaden *(gemeten)* |
| Een SQL-hek dat een gestuurde query weigert | **Ja** — `assertSafeReadQuery` *(gemeten)* |
| Een NL→SQL-pijplijn met vertrouwenssignalen | **Ja** — `/query/think`, inclusief het payload uit §4.1 *(gemeten)* |
| Geverifieerde, herbruikbare antwoorden | **Ja** — `saved_questions` + de verified-fast-path *(gemeten)* |
| De MCP-transportlaag + tooldefinities zelf | **Nee** — repo-brede grep op "mcp" levert alleen commentaar en docs op *(gemeten)* |

Eén ontbrekende rij. Dat is dagen werk, geen kwartaal. De reden dat het er niet
is, is niet architectuur maar prioriteit — en dat is een defensibele keuze
geweest, geen vergissing.

---

## 6. Kosten — de eerlijke vergelijking

**Clarion meet dit als enige van de twee aantoonbaar.** *(gemeten)*
`ai_call_log` legt per call model, tokens en `cost_usd` vast met de tarieven uit
`utils/aiPricing.ts`; `ai_usage` rolt per tenant per maand op; `/admin/ai-usage`
toont het. Er zijn zachte maandbudgetten per tenant die **vóór** de call
afbreken met een 402, dus een doorgeschoten budget kost geen geld.

De kostenbeheersing die al in de code zit, is precies de juiste reflex voor een
"AI voor alles"-product:

- **Modelsplitsing**: Haiku ($1/$5 per 1M) voor plannen en classificeren, Sonnet
  ($3/$15) voor het zware werk *(gemeten)*.
- **Prompt caching op 23 systeemprompts** — cache-reads kosten 0,1× *(gemeten)*.
- **Per-categorie routing** naar Claude of Azure, per tenant instelbaar
  *(gemeten)* — een hefboom op zowel prijs als datasoevereiniteit die de meeste
  concurrenten niet hebben.
- **Deterministische paden die het model overslaan**: de getrapte
  dashboardbewerkingen ("toon 20 rijen", "maak er een staafdiagram van" kosten
  nul calls), de sterschema-templates in plaats van AI-ontwerp, en een
  geverifieerde opgeslagen vraag die generatie volledig overslaat *(gemeten)*.

**De structurele vergelijking:**

| | In-platform AI (vandaag) | Via MCP |
|---|---|---|
| Wie betaalt de tokens | **Clarion** | **De klant**, via zijn eigen agent-abonnement |
| Marginale kosten per antwoord | Modelkosten + DuckDB | Vrijwel alleen DuckDB |
| Marge bij méér gebruik | Daalt | Blijft |
| Zicht op wat gevraagd wordt | Volledig | Gedeeltelijk |
| Kwaliteit van het antwoord | Door Clarion bepaald | Door andermans model bepaald |

Dat "de klant betaalt" is een echt en onderschat voordeel — maar let op de
keerzijde in dezelfde tabel: je geeft de controle over de antwoordkwaliteit weg
aan een model dat je niet kiest. Bij een product dat verkoopt op *vertrouwen in
het antwoord* is dat geen detail.

**Prijskant.** Peliqan begint bij €350/mnd, geteld per connectie *(claim)*.
Clarion's kostenbasis ligt daar ordes onder. Een MCP-endpoint verandert die
verhouding niet — het verplaatst alleen wie de tokens betaalt. Het segment ónder
die €350-drempel blijft voor Peliqan onbereikbaar en voor Clarion bedienbaar, en
dat blijft het sterkste commerciële feit in de hele vergelijking.

---

## 7. Aanbeveling

**1. Houd de in-platform AI als het product. Niet verdunnen.** Dit is de
differentiator, en de concurrent beweegt er juist naartoe. Alles wat de
vertrouwenslaag dunner maakt om breedte te kopen, is de verkeerde ruil.

**2. Bouw MCP als een deur op hetzelfde bewaakte oppervlak, niet als tweede
product.** Concreet, drie tools, allemaal read-only, allemaal op het bestaande
`api_tokens`-mechanisme:

- `list_questions` — de opgeslagen (en geverifieerde) vragen, zodat de agent
  weet wat er betrouwbaar te vragen valt.
- `run_saved_question` — het `addin`-pad, ongewijzigd. Dit is de veiligste tool
  die er bestaat: vooraf goedgekeurde SQL, bij uitvoering opnieuw bewaakt.
- `ask` — de volledige `/query/think`-pijplijn, inclusief beleid, hek en
  reparatie.

**3. De vertrouwenspayload is een harde eis, geen extraatje.** Elk antwoord over
MCP draagt `verified`, `sources` met versheid, `assumptions`, `confidence` en
`policyNotice` als gestructureerde velden mee. Zonder dat is Clarion over MCP
niet te onderscheiden van een SQL-endpoint, en dan hebben we onze eigen
differentiator eruit gestript op de enige plek waar hij moest tellen.

**4. Wat NIET te doen:**
- **Geen ruwe-SQL-tool over MCP.** Dan ben je een database met extra stappen.
- **Geen schrijfacties.** Writeback is een andere risicoklasse — het schrijft in
  het boekhoudsysteem van een klant — en hoort niet aan een deur die door
  andermans agent bediend wordt.
- **`api_tokens` niet verbreden naar de hele API.** De smalle oppervlakte ís de
  beveiliging; het commentaar in `routes/addin.ts` zegt dat al.
- **Niet de eigen chat vervangen door "gebruik Claude maar".** Dat is de kamer
  opgeven voor de deur.

**5. Volgorde.** MCP is goedkoop, dus het hoeft niet te wachten — maar het is
minder urgent dan de twee dingen die het antwoordvermogen zelf vergroten: de
query-laag un-scopen en een tweede bron (de spreadsheet-connector, inmiddels
gebouwd). Een agent die maar één bron kan bevragen loopt tegen dezelfde muur als
de chat.

**6. Eén ding dat groter is dan MCP en hier boven water kwam: Apache Ossie
(voorheen Open Semantic Interchange).** Zie §9 — apart uitgezocht, want de eerste
versie van dit document noemde het als onbevestigde marktclaim en dat was te
slordig voor iets van deze omvang.

---

## 8. Wat dit document niet weet

- **Geen enkele Peliqan-feature is draaiend gezien.** Hun MCP-server, hun
  governance-laag en hun SOC 2 zijn claims uit hun eigen marketing.
- **Er is geen bake-off.** De vergelijking die echt zou tellen — dezelfde tien
  vragen over dezelfde Exact Online-dataset, één keer via Clarion's chat, één
  keer via een agent op een MCP-endpoint — is niet gedaan en zou meer waard zijn
  dan dit hele document.
- **De marktcijfers in §3 zijn andermans cijfers.** De richting is
  waarneembaar; de percentages heb ik niet gecontroleerd.

---

## 9. Apache Ossie / Open Semantic Interchange — nagekeken

Toegevoegd 2026-09-01 op vraag van de eigenaar. **Dit corrigeert §7.6 van de
eerste versie**, die OSI noemde als onbevestigde marktclaim onder een naam die
inmiddels niet meer de juiste is.

### 9.1 Wat het is

Een leveranciersneutrale **YAML/JSON-specificatie voor semantische metadata**:
een formaat waarin je opschrijft wat je datasets, velden, relaties en metrics
*betekenen*, zodat een ander product dat kan lezen. De objecten
*(geverifieerd tegen `core-spec/spec.yaml` in de repo)*:

| Object | Verplicht | Optioneel |
|---|---|---|
| `semantic_model` | `name`, `datasets` | `description`, `ai_context`, `relationships`, `metrics`, `custom_extensions` |
| `dataset` | `name`, `source` | `primary_key`, `unique_keys`, `description`, `ai_context`, `fields`, `custom_extensions` |
| `field` | `name`, `expression` | `dimension`, `label`, `description`, `datatype`, `ai_context`, `custom_extensions` |
| `relationship` | `name`, `from`, `to`, `from_columns`, `to_columns` | `custom_extensions` |
| `metric` | `name`, `expression` | `description`, `datatype`, `ai_context`, `custom_extensions` |

Twee dingen vallen op. **`ai_context` is een eersteklas veld op élk niveau** —
de spec is expliciet ontworpen voor agenten, niet alleen voor BI-tools. En
**`custom_extensions`** laat een leverancier eigen metadata meedragen zonder de
compatibiliteit te breken, wat betekent dat exporteren nooit betekent dat je
iets moet weggooien.

**Buiten scope, en dat is de kern:** dataformaten en query-interfaces. Ossie
standaardiseert de *beschrijving* van betekenis, niet de opslag en niet de
uitvoering. Het is dus geen alternatief voor Clarion's warehouse of query-laag,
en ook geen concurrent van MCP — MCP vervoert antwoorden, Ossie beschrijft
modellen.

### 9.2 Is het matuur? Gesplitst antwoord

**De governance is echt volwassen.** Gestart september 2025, v1.0 aangekondigd
op 27 januari 2026 onder Apache 2.0, in juni 2026 gedoneerd aan de Apache
Software Foundation en als **Apache Ossie** in de Incubator gegaan
(`github.com/apache/ossie`). Er is een JSON Schema, en referentie-converters
voor dbt (MetricFlow), GoodData, Salesforce en Apache Polaris zijn gemerged.
Dat is meer dan een persbericht.

**De adoptie is nul.** Twee harde signalen:

1. **Geen enkel semantic-layer-product levert vandaag een import- of
   exportfunctie voor eindgebruikers** *(stand juli 2026)*. Wat er is, zijn
   referentie-converters in de repo — geen productfuncties. De eerste native
   import/export in een BI-tool wordt eind 2026 verwacht.
2. **De spec beweegt nog.** Ondanks de "v1.0 finalized"-aankondiging van januari
   staat de repo op **`0.2.0.dev0`**, met `0.1.1` als laatste release. Dat is
   geen bevroren standaard; dat is een spec in ontwikkeling met een
   marketingnummer eroverheen.

En er is een structureel bezwaar dat serieus genomen moet worden: standaarden in
data-infrastructuur mislukken doorgaans wanneer de grootste leveranciers baat
hebben bij het probleem. **Semantische fragmentatie is duur voor gebruikers en
strategisch nuttig voor platformen** — een klant die vastzit in Snowflake
Semantic Views is een klant die blijft. De belofte is import en export overal;
de huidige realiteit is smaller.

### 9.3 Wat het Clarion zou kosten — gemeten

Clarion's productlaag is **al bijna een Ossie-model**, alleen uitgedrukt in
Postgres-tabellen in plaats van YAML *(gemeten in
`20260402000017_create_data_products.ts`)*:

| Ossie | Clarion | Past het? |
|---|---|---|
| `semantic_model` | `data_products` + `star_schemas` (incl. `grain`) | Ja |
| `dataset` | `product_tables` (`table_name`, `display_name`, `description`, `table_role`) | Ja; `primary_key` via `business_key_column` |
| `field` | `product_columns` (`column_name`, `data_type`, `transformation_expression`, `description`, `column_role`, `additivity`) | Ja, met meer detail dan de spec vraagt |
| `relationship` | `product_relationships` (`from_table_id`, `from_column_name`, `to_…`) | Ja, 1:1 |
| `metric` | `product_kpis` (`name`, `formula_sql`, `description`, `formula_plain_text`, `question_text`) | Ja |
| `ai_context` | descriptions + `plain_summary` + `question_text` + `business_glossary` | **Clarion heeft hier méér dan de spec verwacht** |

**Eén concrete wrijving, en het is de enige:** `expression` is per SQL-dialect,
en de spec kent ANSI_SQL, SNOWFLAKE, DATABRICKS, MDX en TABLEAU — **DuckDB staat
er niet bij**. Clarion's expressies zijn DuckDB-SQL. Simpele expressies zijn
ANSI-conform en kunnen zo mee; wat dat niet is, hoort in `custom_extensions`.
Geen blokkade, wel iets om te weten voordat iemand belooft dat de export
"gewoon draait" op een ander platform.

### 9.4 Aanbeveling: nu volgen, niet bouwen

**Nu niets bouwen, en het kost ook niets om te wachten.**

- **Geen importer.** Niemand kan vandaag een Ossie-bestand voor je produceren.
  Een importfunctie zou nul klanten bedienen.
- **De semantische laag niet herstructureren om Ossie-vormig te worden.** De
  spec staat op 0.2.0.dev0 en beweegt; meebewegen betekent het twee keer doen.
  En het is niet nodig — de vorm past al (§9.3).
- **De exporter is het enige dat er ooit moet komen, en het is klein.** Omdat de
  mapping bijna 1:1 is, is dit een generator over tabellen die al bestaan — een
  paar dagen, geen migratie, geen risico voor draaiende klanten. Er is geen
  enkele reden om die dagen nú te besteden.
- **De aanleiding om te bouwen is commercieel, niet technisch.** De vraag "kan
  ik mijn semantische laag meenemen?" is een bezwaar in een verkoopgesprek, niet
  een technisch tekort. Het antwoord erop is één exportknop. Bouw hem bij het
  eerste van deze twee signalen: **een prospect die het vraagt**, of **een grote
  leverancier die een echte import levert** (want dan wordt "wij kunnen
  exporteren naar X" pas een bruikbare zin).
- **Wat vandaag wél waar is en waarde heeft:** dat Clarion's semantiek in
  opsombare tabellen zit en niet in prompts of code verstopt zit, is precies wat
  die export later goedkoop maakt. Dat is geen actie, dat is een eigenschap om
  niet kwijt te raken.

### 9.5 Grenzen van dit stuk

De repo-inhoud (spec-objecten, versienummer) is direct gelezen. De
adoptiestand, de tijdlijn en het strategische bezwaar komen uit
zoekresultaten van september 2026, niet uit eigen waarneming; Snowflake's eigen
aankondigingspagina is geblokkeerd door de egress-policy van deze omgeving. Ik
heb geen enkel product een Ossie-bestand zien im- of exporteren.
