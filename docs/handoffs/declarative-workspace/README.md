# Handoff: the declarative workspace (Catalog + Definitions)

**Design of record for `docs/backlog/declarative-data-engineering.md`.** Read
that document first — it carries the investigation (click paths, duplication,
the two-store defect), the contract ("the user declares, Clarion derives") and
the backend half. This folder holds the screens.

**Implemented (2026-09-22, same evening, same branch).** The catalog and the
Definitions pane now exist in the app, built on the existing components (see
§0a of the design doc for the exact list). For what shipped, the real pages
supersede these boards; the boards stay the design of record for what did not
ship yet — the source-table drafts as inline Keep / Discard, the attention and
review lists on the landing, the new-subject panel inside the catalog, and
every retirement (`/build`, `/review`, the workshop, Manage mode).

**Revision 2 (2026-09-22, evening).** After reviewing the first boards the
owner settled that the **catalog is the workspace**: no separate Model page,
one tree on the left with sources under their own mark, no All / Sources /
Products choice, no Grid / List / Structure toggle, the glossary as its own
Definitions pane, and the assistant as a floating chat. The Model boards were
replaced by Catalog boards; Definitions and the topic page are unchanged apart
from their link copy.

**Live canvas:** artifact "Clarion Declarative Workspace"
(https://claude.ai/artifact/XXoaDJY7jRe9prZ1PfiGA8) — pan and zoom, twelve
artboards laid out in four rows. Private until shared from its Share menu.

## The screens

| File | What it shows |
|---|---|
| `screens/Main.png` | **Catalog — a table's declaration.** The everyday screen: the tree (subjects · shared data · your tables · sources by their mark) · the declaration (what one row is, description, SQL, derived columns) · context (lineage, health, history). One action: Save. The assistant folded into a pill. |
| `screens/Catalog-Diff.png` | The same screen while the assistant proposes a change. The diff sits **on the declaration**, with Keep / Discard; Keep is Save. Nothing is stored before Keep. |
| `screens/Catalog-Health.png` | Nothing selected: **what needs you** — built · need attention · building · to review, the attention list, the review list per source table, what changed. This replaces the Trust tab and the Suggestions queue. |
| `screens/Catalog-Subject.png` | A subject selected: what it answers, its tables as cards with status, the star drawn from the foreign keys, its metrics with a door to Definitions. |
| `screens/Catalog-Source.png` | A source selected, by its mark: sync state, *read this first* (the vendor notes from the source package), the synced tables with what they feed and how many drafts wait on them, the door to Sources for sync / analyse / picking tables. |
| `screens/Catalog-SourceTable.png` | A source table: the vendor's meaning where documented, Clarion's drafts inline with **Keep / Discard** — the review job — your note, what it feeds, relations with their measured state, sample rows. |
| `screens/Catalog-NewSubject.png` | A source with no subjects yet — today's `/build` plan panel, inside the catalog. `/build` retires. |
| `screens/Definitions.png` | **Definitions.** One list, three kinds on one card: term, metric, verified answer. Grouped Everywhere → per subject. |
| `screens/Definitions-Edit.png` | Editing "Active customer": name, meaning, examples, and *In the data* — the existing glossary link, with the picker. |
| `screens/Topic.png` | The topic page with Manage mode **gone**. Unchanged for viewers; curators get *Open in the Catalog →* and *Definitions →* under the trust line. |
| `screens/Rail.png` | The Studio group before and after: six entries, one job each. |
| `screens/Map.png` | Every affected surface and where it lands. |

`prototype/*.dc.html` are the artboards as static HTML (open any in a browser;
they carry no runtime). `prototype/generate.mjs` regenerates them and is the
single place the shell, tree, marks and tokens are defined — change it, not
the outputs. Every colour, radius, font and spacing value is an Observatory
token from `frontend/app/globals.css`; the connector marks are the paths and
hexes from `frontend/lib/connectorIcons.tsx`; the rail, top bar, chips and tab
styles copy `IconRail.tsx`, `TopBar.tsx` and `ManageLayer.tsx` class for
class, so the implementation is a recreation with existing components, not a
new look.

## Fidelity

High on structure, layout, copy and vocabulary. Placeholder on data: table
names and SQL are the Exact Online template's, the vendor notes are the ones
the source package ships, row counts, timestamps and the "Ines" edits are
invented. The assistant's answer text is what a good answer looks like, not a
prompt.

## Non-negotiables carried into the screens

- Three responsibilities and nothing else on the page: review, check the
  health, adapt. No mechanics as buttons — Deploy, Run, Refresh-this,
  Deploy-all, cells and run-full do not exist on any screen. Save validates
  and rebuilds; the state is shown, never operated. Scheduling stays on
  `/pipelines`.
- One tree, one view. No layer chips, no view toggles, no cards grid.
- A source is identified by its mark and is read-only here: sync, analyse and
  picking entities stay on Sources.
- One editor for SQL, one store (`product_tables.transformation_sql` with
  `declared_by`). `product_table_cells` goes.
- The assistant proposes a diff on the declaration; Keep is Save. Drafted
  meanings are proposals with Keep / Discard; nothing is used before a yes.
- Definitions are documented, not executed (owner decision, 2026-09-22).
- Viewers' topic page does not change.
