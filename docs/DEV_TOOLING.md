# Dev tooling & workflow — recommendations

> For the solo-dev-on-Windows, no-Docker, no-local-data, test-in-staging setup.
> Read alongside `docs/DEV_FLOW.md` (the daily loop) and `CLAUDE.md` (the rules).

The honest summary: **you don't need more tools — you need a few guardrails,
because you test against real revisions instead of a local stack.** Below is
what to add, what to skip, and why.

---

## 1. Knowledge: stay in-repo. Skip Obsidian.

**Recommendation: do not adopt Obsidian (or Notion, or any external wiki).**

Your "second brain" for this project is already `CLAUDE.md` + `docs/`. That is
the *only* knowledge store the agent actually reads at the start of every
session. An Obsidian vault would be a second copy that (a) drifts out of sync
with the code, and (b) is invisible to Claude — so every session would start
from a worse picture, not a better one. For a solo dev, one source of truth that
both you and the agent share beats a prettier one only you can see.

**The one real problem with the current setup:** `CLAUDE.md` has become huge.
The "Current State" changelog is now most of the file, and it's loaded into
context every session — burning tokens and burying the rules under history.

**Fix (do this soon):**
- Keep `CLAUDE.md` lean: *current* architecture, the non-negotiables, the
  folder map, the env vars. The stuff that describes reality **now**.
- Move the dated session-by-session log to `docs/CHANGELOG.md`. History stays
  available; it just stops loading every session.
- Rule of thumb: if a line describes something that already shipped and won't
  change how the next change is made, it belongs in the changelog, not CLAUDE.md.

This single change improves every future session more than any new tool would.

---

## 2. Agents: no sprawl. What you have is enough.

**Recommendation: do not build a fleet of custom agents.**

Claude Code already ships the three that matter for a project this size:
`Explore` (fan-out search), `Plan` (architecture/design passes), and the
general-purpose agent for multi-step work. Custom agents are *maintenance
surface* — prompts that rot, overlap, and have to be kept in sync with the
codebase. For one developer, that cost isn't repaid.

The leverage for an AI-assisted solo project isn't more agents — it's the two
things that make *any* agent succeed: **good in-repo docs** (§1) and **good CI
gates** (§3). You now have both.

The only "agent-like" habit worth keeping: before clicking **Promote**, do a
quick read-only review pass ("what did this change touch, what could it break").
That's a 2-minute discipline, not a tool to install.

---

## 3. The real gaps — what to add, ranked by value

You test in production-adjacent revisions. That makes **observability**, not
local infra, the thing you're actually missing. In priority order:

### 3a. Error monitoring (highest value — do this first)
If you test against live revisions, you must *see* failures within seconds, not
when a user complains. Add **Sentry** (free tier is plenty) or the **App
Insights browser SDK** to the **frontend first**, then the backend.
- Frontend: catches the white-screen / unhandled-render class that a typecheck
  can't — exactly the failure mode that bit the Vega dashboards migration.
- Backend: catches 500s and unhandled promise rejections with stack + tenant.
- Wire release tags to the deployed revision suffix so an error points at the
  exact revision you'd roll back.

### 3b. Smoke test on the 0%-traffic revision, before Promote
You already have `e2e/smoke.spec.ts` (Playwright) and `deploy.yml` prints the
new revision's FQDN. Close the loop: add a job that runs the smoke spec against
that FQDN. Then "Promote" means "the new revision served real traffic in a
headless browser and login + key pages rendered." Catches the broken-build class
*before* it reaches users — the safety net that makes test-in-prod sane.

### 3c. Uptime + health alert
One external ping on `/health` (or an Azure availability test) with an email
alert. Scale-to-zero means a cold-start bug or a bad migration can take the app
down silently; this is the cheapest possible smoke alarm.

### 3d. Confirm Postgres backups / PITR (one-time)
Azure Postgres Flexible Server has point-in-time restore on by default (7-day
window). Confirm it's enabled and note the window in `DEPLOY.md`. You're one bad
additive-migration assumption away from needing it; verify before you do.

### 3e. Already handled — leave alone
Dependabot (weekly), the additive-migration rule, manual Promote gate, and now
the typecheck gate + layer-cached/path-filtered deploy. These are the right
boundaries; don't add ceremony on top.

---

## 4. The daily loop (least manual interference)

1. **Edit frontend** → `npm run dev` in `frontend/` pointed at the deployed
   backend via `NEXT_PUBLIC_API_URL` (see `frontend/.env.local.example`).
   Instant, real data, no Docker.
2. **Before push** → `npm run check` (frontend + connectors typecheck). Green is
   the bar.
3. **Push to `main`** → `check.yml` runs; `deploy.yml` builds *only what changed*
   (cached layers) and lands a **0%-traffic revision**.
4. **(future) smoke job** runs against that revision → green.
5. **Click Promote** (`promote.yml`) → 100% traffic to the new revision.
6. Something's wrong in prod → Promote the previous revision back (instant,
   no rebuild) and Sentry tells you what broke.

The manual steps are exactly one: the Promote click. That's the gate you *want*
to keep — it's the human "yes, ship it" on a test-in-prod flow.

---

## TL;DR

- **No Obsidian.** Keep knowledge in `CLAUDE.md` + `docs/`; trim CLAUDE.md by
  moving the changelog to `docs/CHANGELOG.md`.
- **No extra agents.** Explore/Plan/general-purpose + good docs + CI gates is
  the whole kit for a solo project.
- **Add observability**, in order: error monitoring (Sentry) → smoke-on-revision
  before Promote → uptime alert → confirm PITR.
- Daily flow is one manual step: the Promote click.
