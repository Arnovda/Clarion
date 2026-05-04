# Clarion — AI-Powered Data Intelligence Platform

## What this product is

Clarion is a SaaS platform for SMB business users (owners, managers, analysts). Users connect their business databases, and the platform's AI understands the schema, generates definitions, discovers relationships, monitors data quality — and then lets users ask questions about their data in plain language. No SQL, no technical knowledge needed. The AI generates SQL behind the scenes and returns answers in plain sentences with charts.

Three user roles:
- **Admin**: Connects data sources, reviews AI-generated definitions, manages the team
- **Analyst**: Designs data products (star schemas), builds dashboards, explores data
- **Viewer**: Asks questions and views dashboards — the core business user

## Design system

Use the "Nexus Cobalt" design system with warm accents:

**Base palette:**
- Primary: navy #003358, surface: #f8f9ff
- Tonal architecture: use color shifts between surface layers instead of borders to define sections
- Surface hierarchy: surface (#f8f9ff) → surface-container-low (#eff4ff) → surface-container (#e6eeff) → surface-container-high (#dde9ff)
- Cards use surface-container-lowest (#ffffff) against tinted backgrounds for natural lift

**Typography:**
- Headlines: Manrope (geometric, modern) — use large scale contrasts for editorial feel
- Body & labels: Inter (readable at all sizes)
- Large headline paired with small metadata creates sophistication

**Warm accents added:**
- Amber/gold (#f59e0b, #fbbf24) for positive business metrics and confirmed/approved states
- Teal/cyan (#06b6d4, #8fdfff) for AI-generated elements — creates visual language: "blue = your data, teal = AI added this"
- Purple (#7c3aed) for AI chat interface elements
- Error: #ba1a1a (used sparingly, only for real problems)

**Premium rules:**
- No 1px borders for sectioning content — use tonal background shifts instead
- Borders only as "ghost borders" (outline-variant at 15% opacity) when accessibility demands it
- Shadows only on floating elements: 0px 12px 32px rgba(13,28,47,0.06)
- Glassmorphism for floating panels: 60% opacity surface-variant + 24px backdrop-blur
- Deep-sea gradient (primary → primary-container at 135deg) for primary CTAs
- Buttons: rounded corners (0.375rem), hover = brightness shift, never size change
- Data chips: secondary-container (#8fdfff) with full roundedness (pill shape)
- No horizontal divider lines in lists — use vertical whitespace and alternating subtle fills instead

**Light mode only.**

## Global layout — three-panel architecture

The entire app uses a persistent three-panel layout. This is the core of the premium feel — it looks like Figma, Linear, or a high-end Bloomberg terminal.

```
┌──────────┬──────────────────┬─────────────────────────────────────────┐
│          │                  │  [Pill] [Pill] [Pill]          🔔  👤   │
│  ICON    │  CONTEXT         │  ─────────────────────────────────────  │
│  RAIL    │  PANEL           │                                         │
│          │                  │  Main content area                      │
│  💬 Ask  │  (adapts per     │  (changes based on selected pill        │
│  📊 Dash │   active tab)    │   and selected item in context panel)   │
│  📖 Dict │                  │                                         │
│  ❤️ Hlth │                  │                                         │
│  ⭐ Prod │                  │                                         │
│  🔌 Conn │                  │                                         │
│  📋 Revw │                  │                                         │
│  👥 Team │                  │                                         │
│          │                  │                                         │
│ ──────── │                  │                                         │
│  ⚙️      │                  │                                         │
│  👤      │                  │                                         │
└──────────┴──────────────────┴─────────────────────────────────────────┘
   48px         240px                    remaining width
```

### Panel 1 — Icon Rail (48px wide, always visible)

- Dark navy background (#003358)
- Logo at top (Clarion icon/monogram)
- 8 main navigation icons vertically stacked, each with a tooltip on hover
- Active tab: teal left-border accent (3px) + brighter white icon. Inactive: muted white icon at 50% opacity
- Divider line before bottom section
- Bottom: Settings gear icon, User avatar (clicking avatar opens profile dropdown with Sign out)
- This panel never changes, never collapses — it's the permanent anchor

**Navigation items visible by role:**
- Everyone: Ask, Dashboards
- Admin + Analyst: Data Dictionary, Data Health, Data Products
- Admin only: Connect, Review Queue, Team

### Panel 2 — Context Panel (240px wide, content adapts per active tab)

- Background: surface-container-low (#eff4ff) — subtly different from main content, creates depth without borders
- Resizable via drag handle on right edge
- Can collapse to 0px with a toggle button, giving full width to main content
- Contains a scrollable tree/list that's specific to each tab (detailed below per page)
- Items are clickable — selecting one updates the main content area
- Active item: surface-container-highest background + teal left accent

### Panel 3 — Main Content (remaining width)

- Background: surface (#f8f9ff)
- Top bar (inside this panel):
  - Left: page title or breadcrumb
  - Center: pill sub-navigation buttons (rounded pills, surface-container-highest when active, text-only when inactive)
  - Right: notification bell with unread badge, user avatar
- Below the top bar: scrollable content area
- Content changes based on which pill is active AND which item is selected in the context panel

### Top bar search

- A global search bar "Ask your data anything..." appears in the top bar on every page
- Clicking it navigates to the Ask page with the query pre-filled
- Subtle teal glow on focus

---

## Page 1: Ask Your Data

**Icon:** Chat bubble
**URL:** /ask
**Audience:** All roles
**This is the hero page — the first thing users see after login.**

**Context panel shows:**
- Section: "Recent Conversations" — list of past conversations with title (first question), timestamp, message count
- Section: "Suggested Questions" — 4-6 AI-generated question chips based on connected data (e.g., "Top-selling products last quarter?", "Revenue trend by region?")
- Each conversation item: click to load that conversation in the main area
- "+ New Conversation" button at top

**Pills:** None — the chat interface is the only view.

**Main content:**
- Large AI chat interface filling the content area
- Empty state (no conversation selected): welcome message "Hi [name], your data is ready. Try asking:" with suggested question chips
- User messages: right-aligned, dark navy bubble, white text
- AI responses: left-aligned, white card with subtle teal left-border (2px, signals AI-generated)
- While AI is thinking: animated teal dot loader with text "Thinking..."
- Source/connection selector dropdown at top of chat: lets user pick which data source to query (grouped: single sources, integration views)

**Inside each AI response:**
- Plain-language answer text (1-3 sentences, no technical jargon)
- If data returned: inline results card with mini data table (max 10 rows shown, "Show all" expander)
- If chartable: auto-generated bar/line chart below the answer
- Confidence badge: subtle pill showing "High confidence" (gold) or "Needs review" (amber) or "Blocked" (red)
- Action row: "Pin to Dashboard" button, "Show SQL" toggle (admin/analyst only — reveals SQL in a code block), "Export CSV" button, thumbs up/down feedback buttons
- If the query included extended reasoning: expandable "Show reasoning" section

**Entity disambiguation:**
- When AI finds multiple matches for a value, shows inline picker as a follow-up message: "Did you mean: [Chip: Brugge] [Chip: Bruges] [Chip: Brussel]?"

**Repair loop:**
- When AI is auto-fixing a query: subtle progress message in the chat "Refining answer... (attempt 2/5)"
- Admin can expand to see diagnostic queries being run

**Blocked query:**
- When confidence is too low: message "I don't have enough context to answer that confidently yet. This question has been noted for review." styled with amber background

---

## Page 2: Dashboards

**Icon:** Grid/chart icon
**URL:** /dashboards
**Audience:** All roles

**Context panel shows:**
- Section: "My Dashboards" — list of user's saved dashboards
- Section: "Favorites" — starred dashboards
- Section: "Shared with me" — dashboards from other users (future)
- Each item: dashboard title, small timestamp, favorite star
- "+ Create with AI" button at top (teal gradient, prominent)

**Pills:** `All` · `Favorites` · `Reports`

**Main content (All / Favorites pill — dashboard list):**
- Grid of dashboard cards (2-3 columns)
- Each card: thumbnail preview, title, description snippet, creator name, last updated, favorite toggle, widget count
- Click card → opens dashboard viewer

**Main content (Reports pill):**
- Report builder interface
- Left sidebar within content: report title input, period text input, KPI selector with checkboxes from confirmed KPI definitions
- Main area: "Generate Report" button, results display with KPI value cards, bar chart (auto-generated if 2+ numeric KPIs), AI-written executive narrative paragraph (1-4 sentences)
- "Export PDF" button

**Dashboard viewer (when a dashboard is opened):**
- Full-width dashboard with widgets arranged in responsive grid
- Filter bar at top: date range picker (from/to), dropdown select filters (configured per dashboard)
- Widget types supported: KPI cards, bar charts (horizontal/vertical/stacked), line charts, pie charts, combo charts, radar charts, treemaps, top-N lists, data tables
- Each widget: title, chart, subtle "..." menu (edit, remove, export)
- Cross-filtering: clicking a bar in one chart filters other widgets
- Drill-down: clicking a bar opens a detail view
- "Refine with AI" floating button — opens a chat overlay to modify the dashboard conversationally ("make the revenue chart weekly instead of monthly")
- "Download Report" button — generates PDF with AI executive summary
- Auto-refresh indicator (if configured)
- Back button to return to dashboard list

**Dashboard creation flow (triggered by "+ Create with AI"):**
1. User types what they want: text input "Describe your dashboard..."
2. AI asks 3-4 clarifying questions with suggestion chips (e.g., "Time period?" → [Last 30 days] [Last quarter] [YTD] [Custom])
3. Loading state with animated teal shimmer: "Claude is designing your dashboard..."
4. Dashboard preview appears — user can accept, refine, or start over
5. Save with name and description

---

## Page 3: Data Dictionary

**Icon:** Book/dictionary icon
**URL:** /dictionary
**Audience:** Admin, Analyst

**Context panel shows:**
- Two collapsible sections with headers:

**▾ SOURCES**
- Tree view: connections as parent nodes (with database type icon: PostgreSQL, MySQL, SQL Server, SQLite), tables as children
- Each connection node: expand/collapse, shows table count
- Each table node: table name, small status dot (gold = confirmed, teal = AI draft, grey = not profiled)
- Clicking a table selects it and loads its details in the main content

**▾ PRODUCTS**
- Tree view: data products as parent nodes (with star icon), their fact/dimension tables as children
- Each product node: product name, status badge (Active/Draft/Error)
- Each table node: table name, role tag (F = fact, D = dimension)
- Clicking a product table loads its details in the main content

**Pills:** `Dictionary` · `Relations` · `KPIs`

### Dictionary pill (default):

Shows details for the selected table from the context panel.

**If a source table is selected:**
- Table header: table name + AI-generated display name (e.g., "klanten → Customers")
- Status badge: "AI Draft" (teal) or "Confirmed" (gold checkmark)
- Description (editable inline — click to edit, shows save/cancel)
- Row count, last profiled timestamp
- Column table:
  - Columns: Column Name | Type | Display Name | Description | Flags | Quality
  - Flags shown as small chips: PK (navy), FK → target table (clickable link), Dimension (blue), Measure (amber)
  - Display name and description are inline-editable (click to edit)
  - Quality column: null% and distinct% as small text
  - Dimension/measure toggles as clickable chip toggles
- Approval controls: "Confirm All Definitions" button, or per-row confirm checkmark
- Expandable "Audit History" section at bottom: who changed what definition, when (timeline view)
- "Bulk Import" button: opens modal to import definitions from CSV/JSON

**If a product table is selected:**
- Same layout as source table, plus:
- "Lineage" badge: shows which source table(s) this was derived from
- "Last transformed" timestamp
- "Transformation SQL" expandable code block (read-only)
- Quality gate results: BK uniqueness (pass/fail), fan-out check (pass/fail)

**If no table is selected:**
- Search bar: "Search tables and columns..."
- Filter chips: by connection, by status (AI Draft / Confirmed), by quality score range
- Full table list showing all source and product tables in a flat list with: name, display name, connection, column count, quality bar, status badge

### Relations pill:

Full-width interactive graph visualization.

- Each table is a node: rounded rectangle, colored by role — fact nodes (blue fill), dimension nodes (gold fill), bridge nodes (teal fill), unknown (grey fill). Shows table name + display name inside.
- Each FK relationship is an edge: directed arrow line, thickness scaled by confidence. Solid line = confirmed, dashed teal line = AI-suggested.
- Clicking a node: highlights all its connections, dims everything else. Shows tooltip with table name, row count, column count, quality score, "View in Dictionary →" link.
- Clicking an edge: shows relationship detail — type (many_to_one etc.), columns involved (from.column → to.column), overlap %, confidence score, source (declared / name-pattern / AI-suggested / value-overlap).
- Mini-map in bottom-right corner for navigation
- Floating controls: zoom in/out, fit to screen, toggle labels on/off
- Can toggle between "Source model" and "Product model" graphs

**PathFinder (integrated into Relations view):**
- Two dropdown selectors at top of graph: "From: [select table]" → "To: [select table]"
- "Find Path" button
- When path found: highlights the join path on the graph with animated teal edges, shows path as text below: "klanten → verkooporders → verkooporder_regels → artikelen"

**Cross-source views section (below graph):**
- List of defined cross-source views
- Each view: name, tables involved (from which connections), "View" / "Edit" / "Delete" buttons
- "+ Create View" button
- Clicking a view highlights its tables on the graph

### KPIs pill:

- List of all KPI definitions
- Each KPI card: name, plain-text description, SQL formula (expandable, admin only), owner name, status badge (AI Draft / Confirmed)
- Inline editing: click name or description to edit
- "+ Add KPI" button: form with name, description, plain-text formula, optional SQL formula
- Filter by connection
- Search KPIs

---

## Page 4: Data Health

**Icon:** Heart or pulse icon
**URL:** /health
**Audience:** Admin, Analyst

**Context panel shows:**
- Tree view: connections → tables, each with an inline quality score dot:
  - Gold dot: 90%+ score
  - Amber dot: 70-90%
  - Red dot: below 70%
  - Grey dot: not profiled
- Clicking a table loads its quality details in the main content
- "Profile All" button at top

**Pills:** `Overview` · `Rules` · `Trends`

### Overview pill (default):

**If no table selected (shows global overview):**
- Hero metric: overall health score across all tables — large circular gauge or big number (0-100%), with trend arrow showing change vs last period
- Alert banner: if any critical quality issues exist, show at top with red accent and "View Details" action
- Heatmap grid: rows = tables, columns = quality dimensions (Completeness, Uniqueness, Validity)
  - Each cell colored: gold (90%+), amber (70-90%), red (<70%), grey (not profiled)
  - Clicking a cell → selects that table and shows its detail
  - Sortable by worst score, by name, by last profiled date

**If a table is selected:**
- Quality score summary: overall score (large number), completeness score, uniqueness score, validity score — each as a card with RAG coloring
- Row count, business key column, last profiled timestamp
- Field profiles table: field name, data type, null count, null%, distinct count, distinct%, min, max, mean, median, top values (expandable), histogram sparkbar
- Search/filter fields
- "Re-profile" button
- "Run Rules" button

### Rules pill:

- List of quality rules with: rule name, type (null_check / range / format / uniqueness / freshness / custom), target field, pass threshold, latest status badge (PASS green / WARNING amber / FAIL red), pass rate with sparkline
- "+ Add Rule" button: form with rule name, dimension, rule type, target field, threshold, description. Conditional fields per rule type (range: min/max, format: regex pattern, freshness: field + max hours, custom: SQL expression)
- Edit/delete per rule
- Toggle rule active/inactive
- "Run All Rules" button

**Quality failures drawer (slides in from right when clicking a failed rule):**
- Paginated list of failing records
- Each failure: field name, actual value, expected description, first detected date, status (open / acknowledged / resolved)
- Status update dropdown per failure
- Filter by status, by field

### Trends pill:

- Line chart: overall quality score over last 90 days
- Dimension breakdown: completeness, uniqueness, validity as separate colored lines
- Table selector to view trends for a specific table vs global

---

## Page 5: Data Products

**Icon:** Star icon
**URL:** /products
**Audience:** Admin only

**Context panel shows:**
- List of data products with status badge (Active / Draft / Error), last run timestamp
- "+ Design New Product" button at top (opens creation flow)

**Pills:** `Design` · `Lineage` · `Schedules`

### Design pill:

**If a product is selected:**
- Star Schema viewer: interactive ReactFlow canvas showing fact table in center, dimension tables around it
- Each node contains: table name, column list, role badge (Fact / Dimension)
- Edges show join columns
- Below canvas: transformation SQL for each table (expandable code blocks, read-only)
- Quality gate results: BK uniqueness check, fan-out detection — each with pass/fail badge and detail
- "Run Transformation" button (triggers materialization)
- "Edit Design" mode: allows drag-rearranging, editing column mappings

**Product creation flow:**
1. Select source tables to model (checkbox list from connected sources)
2. AI designs star schema: shows preview of fact + dimension tables with transformation SQL
3. Review visual design — adjust if needed
4. Run transformation — shows progress bar per table
5. Quality gates auto-check — shows results

### Lineage pill:

- Flow diagram (ReactFlow): source tables on left → transformation step in middle → product tables on right → warehouse output
- Shows data flow direction with animated edges
- Click any node for details

### Schedules pill:

- Schedule configuration per product:
  - Cron expression with preset buttons: every hour, every 6 hours, daily at 6:00, daily at midnight, weekdays at 7:00, weekly (Sunday), monthly (1st)
  - Custom cron expression input
  - Timezone selector (default: Europe/Brussels)
  - Enabled/disabled toggle
  - "Save Schedule" button
- "Run Now" manual trigger button
- Run history list (last 10 runs): triggered by, status (success/failed/running), tables transformed count, duration, error message if failed, timestamps

---

## Page 6: Connect

**Icon:** Plug icon
**URL:** /connect
**Audience:** Admin only

**Context panel shows:**
- List of connected sources with: name, type icon (PostgreSQL/MySQL/SQL Server/SQLite), status indicator (green = connected, red = error)
- "+ Connect New Source" button at top

**Pills:** `Sources` · `Ingestion`

### Sources pill:

**If a source is selected:**
- Connection details: name, type, host/database info (masked password), created by, created date
- "Test Connection" button with success/error feedback
- "Edit" button (opens edit form for name, credentials)
- "Delete" button (with confirmation)
- "Re-analyse" button (triggers schema profiling)
- Data freshness: "Last synced: 2h ago"
- Table count, column count from last profiling

**Profiling progress banner (shown when profiling is running):**
- Connection name being analysed
- Progress bar with percentage
- 5 phase steps shown vertically:
  1. Reading schema (with sub-message like "introspecting table 12/35...")
  2. Profiling data quality
  3. Claude is learning your data
  4. Saving definitions
  5. Syncing knowledge graph
- Each step: checkmark when done, spinner when active, grey when pending
- Error state with message and dismiss button
- Success state with "Review definitions →" button linking to Data Dictionary

**New source wizard (triggered by "+ Connect New Source"):**
- Step 1: Choose source type — cards with icons:
  - SQLite (file path input)
  - PostgreSQL (host, port, database, user, password, SSL toggle, schema)
  - MySQL (host, port, database, user, password, SSL toggle)
  - SQL Server (host, port, database, user, password, encrypt toggle, trust certificate toggle, schema)
  - Coming soon (greyed out): Exact Online, Odoo, Salesforce, Google Sheets
- Step 2: Enter connection details form
- "Test Connection" button with live success/error feedback
- Step 3: Save → automatically starts profiling

### Ingestion pill:

**If a source is selected:**
- Ingestion wizard interface:
  - Table list from the connected source with checkboxes
  - Each table row: table name, row count, column count, current ingestion status
  - "Select All" / "Select None" buttons
  - Ingestion mode selector: Full Load / Incremental (watermark-based)
  - "Start Ingestion" button
  - Progress view during ingestion: current table name, progress bar, status per table
  - Results after completion: table list with final status (done/error), row counts

---

## Page 7: Review Queue

**Icon:** Inbox/clipboard icon
**URL:** /review
**Audience:** Admin only

**Context panel shows:**
- Summary counts: "14 open gaps", "238 queries logged"
- Filter options: by date range, by resolved/unresolved

**Pills:** `Definition Gaps` · `Query Log`

### Definition Gaps pill:

- Paginated list (50 per page) with pagination controls
- Each gap row:
  - Question text that triggered the gap (the user's question)
  - Gap description (what context was missing)
  - Hit count badge (how many times this gap was encountered)
  - Last hit date
  - Status: Open / Resolved
  - "Mark Resolved" button
  - "Delete" button

### Query Log pill:

- Paginated list (50 per page) with pagination controls
- Each query row:
  - User identifier
  - Question text
  - Confidence score badge: green (85%+), amber (70-84%), red (<70%)
  - Status badge: "Executed" (green), "Blocked" (amber), "Flagged" (red)
  - Timestamp (relative: "2 hours ago")
  - Expandable: generated SQL code block, full error message if blocked

---

## Page 8: Team

**Icon:** People icon
**URL:** /team
**Audience:** Admin only

**Context panel shows:**
- Team member list with: avatar, name, role dot (navy = admin, teal = analyst, gold = viewer)
- Active count
- "+ Invite" button at top

**Pills:** `Members` · `Invites`

### Members pill:

- Active members section:
  - Each member row: avatar, display name, email, role badge (Admin / Analyst / Viewer — colored chips), last active date
  - Actions per member: role change dropdown, deactivate button (with confirmation)
- Deactivated members section (if any):
  - Same layout but greyed out
  - "Reactivate" button

### Invites pill:

- Invite form:
  - Email input
  - Display name input
  - Role selector: Admin / Analyst / Viewer (with short description of each role's permissions)
  - "Send Invite" button
  - On success: shows invitation URL for sharing
  - On error: shows error message
- Pending invites list (if any): email, role, sent date

---

## Additional pages (outside the three-panel layout)

### Login page (`/`)
- Centered card on surface background
- Clarion logo at top
- Email + password inputs (using the design system's input style: surface-container-lowest fill, bottom accent in primary)
- "Sign in" button (primary gradient)
- "Forgot password?" link
- "Create account" link
- Error message display

### Registration page (`/register`)
- Centered card, same style as login
- Fields: Company name, Your name, Email, Password (min 8 chars), Confirm password
- "Create account" button
- "Already have an account? Sign in" link
- Validation messages inline

### Forgot password page (`/forgot-password`)
- Centered card
- Email input
- "Send reset link" button
- Success message after sending

### Reset password page (`/reset-password`)
- Centered card
- New password + confirm password inputs
- "Reset password" button

### Profile page (`/profile`)
- Uses the three-panel layout
- Main content: avatar (clickable to upload), display name (editable with save/cancel), email (read-only), role (read-only), organization name (read-only), member since date
- Collapsible "Change password" section: current password, new password, confirm new password, "Update" button

---

## Notification system

- Bell icon in the top bar with red dot badge showing unread count
- Clicking bell opens dropdown panel with recent notifications (max 20)
- Notification types with distinct icons:
  - Job complete (gear icon, blue): "Profiling complete: 35 tables, 393 columns"
  - Quality alert (warning icon, amber): "Completeness dropped below 75% on klanten"
  - New gap (question icon, purple): "New unanswered question logged"
  - Invite accepted (person icon, green): "Sarah joined the team"
  - Approval (checkmark icon, emerald): "Definition approved by admin"
- Each notification: icon, message text, relative timestamp ("2 hours ago")
- Click notification to navigate to relevant page
- "Mark all read" option

---

## AI visual language

Wherever AI-generated content appears, use a consistent visual pattern:
- Subtle **teal left-border** (2px) on AI-generated cards and chat responses
- Small **teal "AI" badge** on AI-drafted definitions
- AI suggestion modules: semi-transparent tertiary-container background with teal accent
- This lets users always distinguish AI-generated content from manually defined content, building trust

---

## Role-based visibility

**Viewer sees in icon rail:** Ask, Dashboards (2 items)
**Analyst sees in icon rail:** Ask, Dashboards, Data Dictionary, Data Health, Data Products (5 items)
**Admin sees in icon rail:** All 8 items (Ask, Dashboards, Data Dictionary, Data Health, Data Products, Connect, Review Queue, Team)

---

## Mood and feel

Premium but approachable. This is for business people who run wholesale companies in Belgium, not developers or data engineers.

Think: the sophistication of a Bloomberg terminal meets the approachability of Notion, with the intelligence feel of a modern AI product.

- Calm, confident, precise — like a trusted business advisor
- Data feels approachable — charts and numbers always have plain-language context
- AI is helpful and clearly marked — teal accents make AI elements feel friendly and distinct
- Generous whitespace — the three-panel layout naturally creates breathing room
- Smooth transitions between views — pill switches are instant, no page reloads
- The platform should feel like it's always working for you (subtle status indicators, freshness timestamps, quality pulses)
