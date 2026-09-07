# Home experience — from report card to standing brief

> **Status: proposal. No product code changed.** Doc + interactive prototype only.
> Owner asked (2026-09-07): *"Make the home page feel a bit less like 'this is your
> data health, this is what you must do to fix it' and more like a helper and
> personal assistant… Clarion should be your helper assistant with your business
> decisions using your data."*
>
> Prototype: [The Standing Brief](https://claude.ai/code/artifact/1d4e4bee-3a58-410f-9f96-e0b1072f441b)
> — three switchable states (something moved / quiet day / day one).

---

## 1. What the page does today

`frontend/app/home/page.tsx` renders, in order:

1. `MorningBriefCard` — renders **nothing** unless a brief exists for today
2. `HealthSection` — a 0–100 ring + four sub-score tiles
3. `AttentionSection` — stale sources, pending AI review, failed runs
4. `PulsePanel` — the metric picker
5. `DashboardsSection` + `RecentQuestionsSection`

`ViewerHome.tsx` is a second, quieter shape for viewers (9-3) and is already much
closer to right: greeting, one honest freshness line, ask box, brief, dashboards,
questions, subjects.

### 1.1 The five findings

**F1 — Every number on the page is about Clarion, not about the business.**
73, 0/100, 94/100, 100/100, "36/36 tables · 1584/1584 columns · 124/152
relationships". A business owner opening this learns nothing about their company.
The platform is talking about itself, in its own vocabulary, above the fold.

**F2 — It assigns homework on arrival.** *"Tackle the lowest sub-score first."*
*"28 AI suggestions pending review."* *"1 source and 5 products not refreshed."*
These are chores that serve **our** accuracy (better semantic context → better
NL→SQL), framed as the user's failures. Duolingo can run a streak because the
user's goal *is* the streak; here the user's goal is running a company, and data
hygiene is our means, not their end.

**F3 — The scores are unreliable in exactly the way that destroys trust.**
`FRESHNESS 0/100` in the screenshot means "nothing synced in the last 24h"
(`home.ts:36`, `FRESH_WINDOW_HOURS = 24`). For a monthly-close accounting dataset
that is *completely normal*. A score that reads catastrophic during normal
operation teaches the user to ignore every other score on the page — including the
one day it is right. `QUALITY 100/100` has the opposite problem: it cannot go
down, so it carries no information either.

**F4 — `PulsePanel` is a setup wizard squatting in the daily view.** In the
screenshot it shows six unsaved cards and a greyed-out **"Save 0 entries"**. It is
*configuration* rendered in the position where *content* belongs, every single day.

**F5 — The best feature is invisible behind that form.** The dependency chain is:
pulse configured → 06:00 cron runs (`morningBriefService.runDailyBriefs`) → ≥2
`pulse_observations` exist so a delta can be computed → `MorningBriefCard`
renders. Until all four hold, `MorningBriefCard` returns `null` and the user's
first impression — for the first 48 hours, the window that decides adoption — is
**pure chore list**.

### 1.2 The market check

- 60–80% of BI dashboards go unused; **71% of BI seats go unused**; only 25–30% of
  employees use BI tools regularly ([business-analysis.ca](https://www.business-analysis.ca/blog/why-bi-dashboards-go-unused-2026-adoption-gap)).
  Building a better dashboard is not the winning move.
- Tableau Pulse's 2026 positioning is **"Agentic Analytics — notifying users of
  anomalies and their root causes before the user even thinks to ask"**, with a
  digest that leads on an AI summary across followed metrics
  ([tableau.com](https://www.tableau.com/products/tableau-pulse),
  [help.tableau.com](https://help.tableau.com/current/online/en-us/pulse_insights_platform_insight_types.htm)).
  **This is the bar.** Clarion already has the harder half of it built
  (`investigateService` does agentic root-cause) and does not put it on Home.
- The counter-risk is documented too: alert fatigue is caused by static thresholds
  that don't know normal behaviour, and users desensitise and tune out
  ([vectra.ai](https://www.vectra.ai/topics/alert-fatigue)). That is a direct
  argument for §3's "quiet day" state and against a page that always finds three
  things.

---

## 2. The governing principle

> **The assistant speaks first.**

An ask box alone is a *pull* interface: it hands the burden of curiosity back to
the user every morning, and most SMB owners don't know what to ask — that is the
premise Clarion is built on. A scorecard is *push*, but it pushes the wrong
subject (us). The brief is push about **their business**.

So: **"Here's what I noticed. Also, ask me anything."** The ask box is essential
and must not be alone.

---

## 3. The proposed page

Single column at reading width (~780px), not a dashboard grid — because a briefing
is *read*. Top to bottom:

| # | Block | Job |
|---|-------|-----|
| 1 | **The lead** | ONE sentence, largest type on the page, about their business |
| 2 | **Ask box + starter chips** | The core verb, immediately under the lead |
| 3 | **What moved** | 2–4 cards: sparkline, delta, plain-English detail, `Why?` + `Show me` |
| 4 | **Your board** | 4 auto-assembled tiles from what they actually look at |
| 5 | **Tell me what to watch** | Plain-English input → `POST /pulse/suggest` |
| 6 | **Pick up where you left off** | Recent questions + dashboards, quiet |
| 7 | **One operational line** | Consequence-framed, at the bottom |

### 3.1 The lead is the whole proposal

Today the largest thing on the page is `73`. It should be a sentence:

> *Revenue is €38k behind where you'd normally be by the 7th — and almost all of
> it is one customer.*

Not "Revenue is down 4%". A number is a fact; **a sentence with a driver in it is
a finding**, and a finding is what makes someone open the app tomorrow.

### 3.2 The differentiator: the answer is already waiting

`investigateService` runs a 6-step agent loop (hypothesis → SQL → finding →
conclude) and already accepts `pulse_entry_id` and `brief_id` as FKs — it was
*designed* to be triggered from a brief. Today it only runs on demand, behind a
button.

**Run it overnight for the single biggest mover, and put the conclusion on Home.**
In the prototype, card 1's "Why? — already worked out" expands to a 4-step trail
ending in: *"Most likely a payment dispute, not a lost customer. The overdue
invoice predates the drop… worth a phone call before it becomes a write-off."*

Nobody expects the answer to be waiting. This is the "how did it know that"
moment, and it is one cron job away from existing.

### 3.3 Three more things that would land

- **The thing that didn't happen.** *"You've invoiced €12k this month — you'd
  normally be at €40k by now."* Absence is invisible in every dashboard ever
  built, and `pulse_observations`'s daily history is exactly what establishes
  "normally".
- **Cross-user signal.** `query_log` knows three people asked about receivables
  last week. A single-player tool cannot do this; a multi-tenant platform can.
- **Honest silence.** See §3.5.

### 3.4 The board: promotion, not configuration

The owner's instinct — assemble a small dashboard overnight from what the user
looks at — is right, with **one correction**:

> **Recency is the wrong signal. Repetition is the right one.**

The most recently asked question is usually a one-off ("what was that Terrie
invoice?"). Rebuilding it every morning is noise. Promote on *return*: asked 3+
times, or a dashboard re-opened across separate days.

And make promotion **visible and reversible** rather than silent:

> ⭐ *You've asked about margin by supplier three times this month. Want it on your
> board every morning?*  **[Add it]  [No thanks]**

That converts creepy-magic into delightful-magic, and it builds a personal board
**with no settings screen** — which is the whole point.

**On the owner's toggle (auto vs. a specific topic):** yes, but not as a radio
button — that is a config surface again. Make it a sentence:
*"Tell me what to keep an eye on"* → free text → `POST /pulse/suggest` +
`apply-suggest`, which already turn plain English into a pulse entry. The
auto-assembled board is what fills the gap until they say anything.

### 3.5 The quiet day is the most important state

> *Nothing needs you this morning. All six things you watch are inside their
> normal range.*

A briefing that always finds three things is a briefing nobody believes. Rendering
"all quiet" as the **success** state is what makes the loud days credible, and it
is the direct mitigation for the alert-fatigue risk in §1.2.

### 3.6 Day one sells the mechanism

No data yet, so don't render an empty dashboard. Say what happens overnight
("I take a reading of every number you've asked about… I work out why before you
ask"), and make the ask box the only thing to do. Every question asked today is
what makes tomorrow's page good — **telling the user that is what earns the second
visit**.

### 3.7 Where the operational truth goes — it is NOT deleted

The owner asked to get rid of Data Health / Worth Your Attention. **Re-frame and
relocate rather than delete**, for one hard reason: if nobody ever learns the
Exact Online sync has been dead for six days, the platform produces *confidently
wrong answers*. That is a worse failure than a nagging home page.

One line, at the bottom, phrased as what it costs the reader:

> ⏱ Everything above includes sales and purchasing **through Friday 5 September**.
> Exact Online hasn't sent anything since — the last three days are missing.
> **[Refresh now]** · Details

Same fact as `FRESHNESS 0/100`. Business framing, attached to the numbers it
qualifies, at the bottom because it *qualifies* them rather than competing with
them. Curator chores (the 28 AI suggestions, unrefreshed products) move to badges
on Sources / Build — `IconRail` already renders exactly these badges.

---

## 4. Pros, cons, honest risks

### For the change
- Puts the product's actual differentiator (agentic root-cause + trust display) on
  the surface everyone lands on.
- Matches where the market leader is going, using machinery already built.
- Removes the one screen that makes Clarion feel like homework.
- The viewer/operator split can collapse: this page works for both, with the ops
  line and curator badges as the only role-conditional bits.

### Against / risks
| Risk | Mitigation |
|---|---|
| **Silent staleness** — nobody notices a dead sync | §3.7 keeps the signal, re-framed; plus the existing `'source stale'` freshness monitor already notifies admins |
| **Alert fatigue** — three findings every day | Sensitivity is compared against each metric's own history, not a threshold; §3.5's quiet state; hard cap of 3 cards |
| **Overnight compute + AI cost** | Reuse `saved_questions.sql` where possible (zero AI); cap investigations at **one per user per night**; snapshot job already exists and is idempotent |
| **A tile built at 03:00 is stale by 09:00** | Every tile carries as-of; re-run on open when the underlying product refreshed since |
| **Auto-built SQL breaks** (product rebuilt, column renamed) | The tile must *say so*, not vanish — `pulseStateService` already models `snapshot_failed` with `consecutiveFailures`; reuse it |
| **Policy leakage** in unattended materialisation | `prepareUnattendedRead` is already the rule for briefs — same path, no exception |
| **Curators lose their operational cockpit** | They didn't have one worth keeping; Sources / Build / Pipelines are the real work surfaces and already exist |

### Deliberately NOT proposed
- No gamification, streaks or badges anywhere.
- No new AI panel — five exist (per CLAUDE.md's own standing warning).
- No numeric confidence % for business users (existing non-negotiable).
- **Not deleting `/pulse`** — it becomes an edit surface reached from "Edit", not
  the daily view.

---

## 5. Sequencing

**R1 — Reframe (no new backend).** New lead line computed from existing
`pulse_observations` deltas; ask box to the top; health ring + attention feed →
one ops line; `PulsePanel` → "Edit" behind the board. Ships against today's data.

**R2 — The assistant speaks first.** Overnight `investigateService` run for the
top mover, stored on the brief; `Why?` renders the pre-computed trail. This is the
release that changes how the product feels.

**R3 — The board.** Promotion signal from `query_log` + `saved_questions` repeat
counts; the promotion prompt; nightly materialisation with as-of + honest failure.

**R4 — Absence detection.** "Normally by the 7th you'd be at €40k" from
`pulse_observations` history. Highest "how did it know" per unit of work.

---

## 6. Open questions for the owner

1. **How aggressive should overnight AI spend be?** One investigation per user per
   night is ~1 Sonnet loop (~6 calls). At 10 users that is real money. Cap per
   tenant, per user, or only run when a delta breaches sensitivity?
2. **Should the board be per-user or per-tenant?** Per-user is more personal;
   per-tenant means a new colleague lands on a useful page on day one.
3. **Does the ops line survive for viewers?** It is honest but not theirs to fix.
   Recommendation: yes, without the Refresh action (matches today's `ViewerHome`).
