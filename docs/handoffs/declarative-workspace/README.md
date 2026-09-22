# Handoff: the declarative workspace (Model + Definitions)

**Design of record for `docs/backlog/declarative-data-engineering.md`.** Read
that document first — it carries the investigation (click paths, duplication,
the two-store defect), the contract ("the user declares, Clarion derives") and
the backend half. This folder holds the screens.

**Live canvas:** artifact "Clarion Declarative Workspace"
(https://claude.ai/artifact/XXoaDJY7jRe9prZ1PfiGA8) — pan and zoom, ten
artboards laid out in three rows. Private until shared from its Share menu.

## The screens

| File | What it shows |
|---|---|
| `screens/Main.png` | **Model — a table's declaration.** The everyday screen: tree (subjects · shared data · your tables · sources) · the declaration (what one row is, description, SQL, derived columns) · context (lineage, health, history). One action: Save. |
| `screens/Model-Diff.png` | The same screen while the assistant proposes a change. The diff sits **on the declaration**, with Keep / Discard; Keep is Save. Nothing is stored before Keep. |
| `screens/Model-Subject.png` | A subject selected: what it answers, its tables as cards with status, the star drawn from the foreign keys, its metrics with a door to Definitions. |
| `screens/Model-NewSubject.png` | A source with no subjects yet — today's `/build` plan panel, inside Model. `/build` retires. |
| `screens/Definitions.png` | **Definitions.** One list, three kinds on one card: term, metric, verified answer. Grouped Everywhere → per subject. |
| `screens/Definitions-Edit.png` | Editing "Active customer": name, meaning, examples, and *In the data* — the existing glossary link, with the picker. |
| `screens/Topic.png` | The topic page with Manage mode **gone**. Unchanged for viewers; curators get *Edit in Model →* and *Definitions →* under the trust line. |
| `screens/Catalog-Table.png` | The catalog's table page, read-only: rows first, the description, the lineage strip, one *Edit in Model →*. The SQL viewer and the edit forms are removed. |
| `screens/Rail.png` | The Studio group before and after. |
| `screens/Map.png` | Every affected surface and where it lands. |

`prototype/*.dc.html` are the artboards as static HTML (open any in a browser;
they carry no runtime). `prototype/generate.mjs` regenerates them and is the
single place the shell, tree and tokens are defined — change it, not the
outputs. Every colour, radius, font and spacing value is an Observatory token
from `frontend/app/globals.css`; the rail, top bar, chips and tab styles copy
`IconRail.tsx`, `TopBar.tsx` and `ManageLayer.tsx` class for class, so the
implementation is a recreation with existing components, not a new look.

## Fidelity

High on structure, layout, copy and vocabulary. Placeholder on data: table
names and SQL are the Exact Online template's, row counts, timestamps and the
"Ines" edits are invented. The assistant's answer text is what a good answer
looks like, not a prompt.

## Non-negotiables carried into the screens

- No mechanics as buttons. Deploy, Run, Refresh-this, Deploy-all, cells and
  run-full do not exist on any screen. Save validates and rebuilds; the state
  is shown, never operated. Scheduling stays on `/pipelines`.
- One editor for SQL (Model), one store (`product_tables.transformation_sql`
  with `declared_by`). `product_table_cells` goes.
- The assistant proposes a diff on the declaration; Keep is Save.
- Definitions are documented, not executed (owner decision, 2026-09-22).
- Viewers' topic page does not change.
