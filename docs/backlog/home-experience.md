# Home experience — from report card to standing brief

> **Status: R1 + R2 SHIPPED 2026-09-07.** R3 (board promotion) and R4 (absence
> detection) remain — see §5. The findings and the argument below are unchanged;
> §5 marks what landed.
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
| **Quality alerts silently disappear with the attention feed** | Caught on review — they are back as movement cards, and `deriveLead` counts them, so a morning with a live critical alert can never render "nothing needs you" |
| **Pre-computing spends on users who never look** | The dormancy gate above. Still a real trade — see "the open question" below |

### Deliberately NOT proposed
- No gamification, streaks or badges anywhere.
- No new AI panel — five exist (per CLAUDE.md's own standing warning).
- No numeric confidence % for business users (existing non-negotiable).
- **Not deleting `/pulse`** — it becomes an edit surface reached from "Edit", not
  the daily view.

---

## 5. Sequencing

**R1 — Reframe. ✅ SHIPPED.** Lead sentence from the brief's top bullet; ask box
under it; health ring + attention feed → one consequence-framed ops line;
`PulsePanel` behind "Edit" on the board; `ViewerHome` deleted (one page, all
roles). Composed from `/home/summary`, `/briefs/today`, `/pulse/state` and
`/query/starters` in parallel — no new route. The lead lives in a pure
`app/home/lead.ts` so all four tones (cold / waiting / quiet / moved) are pinned
by test.

**R2 — The assistant speaks first. ✅ SHIPPED.** `runOvernightInvestigation` fires
one agent run for the top mover after the brief is written and attaches it via
the `brief_id` that already existed on `investigations` — **no migration**. The
card reads "Why? — already worked out" and replays the stored trail with no model
call; when the run concluded, its conclusion becomes the lead sentence. The gate
is `pickInvestigationTarget`, pure and tested: nothing triggered → nothing runs,
so a quiet morning costs $0.0034.

**R3 — The board.** Promotion signal from `query_log` + `saved_questions` repeat
counts; the promotion prompt; nightly materialisation with as-of + honest failure.

**R4 — Absence detection.** "Normally by the 7th you'd be at €40k" from
`pulse_observations` history. Highest "how did it know" per unit of work.

---

## 5b. The open question: pre-compute vs. lazy

Worth stating plainly, because it is the one design choice here that is a
genuine judgement call rather than a defect fix.

**Pre-computing** (what shipped) costs ~$0.065 on every night something moved,
for an active user. **Running it lazily on the first "Why?" click** would cost
the same per run but only when someone actually asks — and on a month where a
user opens Home 20 times and clicks Why? three times, that is roughly $1.30
against $0.20.

Pre-computing still wins, for one reason that is easy to miss: the conclusion
is not only behind the button, it **becomes the lead sentence**. That is the
difference between "Revenue is down 4%" and "…and almost all of it is one
customer", every morning, not just on the mornings someone clicks. A lazy
version would leave the headline weaker on all twenty days to save money on
seventeen.

The two gates are what make that trade defensible rather than open-ended: a
quiet morning is free, and a dormant reader is free. If the bill still looks
wrong once there is real usage, the next lever is the schema-block cache
breakpoint below (roughly halves a night) — and only after that, lazy.

---

## 6. Owner decisions — settled 2026-09-07

1. **The board is PER-USER.** Each person's board is assembled from their own
   repeat questions and reopened dashboards. Consequence to build for: a brand-new
   colleague has an empty board on day one, so §3.6's cold-start copy carries them
   until they have asked enough to promote anything. (A tenant-level fallback —
   seed a new user's board from the tenant's most-asked questions — is a later
   option, not this slice.)
2. **The ops line stays for viewers, without the Refresh action.** Matches today's
   `ViewerHome`, which already states freshness honestly and offers nothing to
   click: the refresh is not a viewer's to trigger, and a dead button is worse than
   a plain sentence. Curators get the same line plus **Refresh now**.
3. **Overnight AI spend — costed, see §7.** One investigation per user per night.

---

## 7. What a night actually costs

Computed from Clarion's own rate table (`backend/src/utils/aiPricing.ts`, which
matches Anthropic's current published rates) so the estimate lands where
`ai_call_log` will. Models are the ones the code already uses:
`MODEL = claude-sonnet-4-6` ($3/$15 per MTok) and
`MODEL_HAIKU = claude-haiku-4-5` ($1/$5).

**What is free.** The pulse snapshot (Phase 1 of `morningBriefService`) is plain
SQL against DuckDB — no AI, and it already runs. Board tiles are the same: they
re-execute `saved_questions.sql` / `product_kpis.formula_sql`, so a four-tile
board costs **zero tokens**. This is why §3.4 insists the board is built from
*stored SQL*, not regenerated nightly — regenerating it would be the single
largest avoidable line on this page.

**What costs.** Per user, per night:

| Call | Model | ~Cost |
|---|---|---|
| Morning brief (existing) | Haiku | $0.0028 |
| Investigation — 4 × (`plan_next` + `summarise`) + `conclude` | Sonnet + Haiku | $0.0647 |
| Lead sentence | Haiku | $0.0007 |
| **Total, typical** | | **$0.068** |
| **Total, worst case** (agent hits the 6-step `MAX_STEPS` cap) | | **$0.099** |

≈ **7 eurocents per user per night**, ≈ **$2.04 per user per month**. Ten users on
weekdays only ≈ **$15/month**. For scale: the platform's measured AI cost today is
~$0.75–2/month per tenant, so this roughly triples it — from a very low base, and
it buys the one feature the product is actually differentiated on.

**Two gates, not one (added on review, 2026-09-07).** The first stops us
paying on a quiet morning; the second stops us paying every morning for a
**dormant account**. Without it a user who stopped opening Clarion three weeks
ago still accrues ~$2/month for an answer nobody reads — the standing charge
this whole section exists to avoid. `morning_briefs.opened_at` is the honest
signal, the window is `BRIEF_INVESTIGATE_ACTIVE_DAYS` (default 7), and a
brand-new user with no history counts as ACTIVE: their first morning is the one
that decides whether they come back.

**The investigation is ~95% of it.** Without it a night is $0.0034 (5¢/user/month);
with it, $0.068. Every lever that matters is therefore about how often the agent
runs, not how the brief is written:

- **One investigation per user per night, hard cap.** Not per movement.
- **Only run it when a delta actually breached its sensitivity threshold.** On a
  quiet morning §3.5 renders "nothing needs you" and the agent never fires — so
  quiet days cost $0.0034, and the cap is self-limiting in exactly the right way.
- **Investigate the top mover only**, chosen by sensitivity-weighted delta (the
  rule `morningBriefPrompt` already applies when picking its three bullets).
- `MAX_STEPS` is already 6 in `investigateService`; leave it.

**A finding while costing this: `cacheSystem: true` is a no-op on the investigate
calls.** `AIService` sets `cache_control: {type:'ephemeral'}` on the system prompt,
but `AGENT_PLAN_NEXT_SYSTEM` is 417 tokens and `AGENT_CONCLUDE_SYSTEM` 377 — both
below the 1024-token minimum cacheable prefix, so nothing caches and the flag
silently does nothing. The table above is priced at full input rate accordingly.
The real caching opportunity is the **product schema block** (~2,000 tokens,
identical across all 5–7 calls of one investigation and across every user on the
same topic): moving it behind a cache breakpoint would cut the Sonnet input on
steps 2..n by ~90% and take a typical night from $0.068 to roughly $0.035. Worth
doing when the overnight job is built, not before.
