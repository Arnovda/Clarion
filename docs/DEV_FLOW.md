# Dev flow (solo, Windows, no Docker)

Pragmatic flow so you can **test before production** without a local database or
a second environment. Two loops + a light gate.

## Loop 1 — local UI, instant (≈90% of work)
Run the frontend locally against the **deployed** backend (real API + real data),
hot-reloading on every save. No Docker, no DB.

```
cd frontend
copy .env.local.example .env.local   # set NEXT_PUBLIC_API_URL to the deployed /api
npm install
npm run dev                          # http://localhost:3000
```

- One-time: add `http://localhost:3000` to the backend Container App's
  `CORS_ORIGIN` env var (comma-separated) so the browser may call it.
- Use this for all UI/UX work — you see changes in <1s instead of in prod.

## Loop 2 — push to main, it ships itself

There is no branch-and-PR step and no promote click. A push to `main` runs:

1. **Tests** — and they are a GATE now. A red suite means no migration runs, no
   revision is deployed and nothing is promoted. "Tests did not run" counts as
   a failure, not a pass.
2. **Build + migrate + deploy** — the new revision goes up at 0% traffic.
3. **Go live** — the new backend must answer `/api/health` through its staging
   label before traffic moves. If it never comes up healthy, traffic stays on
   the previous version and the run fails loudly.

What makes that safe is not optimism, it is that **a user-visible change ships
behind a feature flag that is off**. Reaching production is not the same as
reaching a customer; the audience is chosen in Loop 3.

**Escape hatches, unchanged:** *Rollback production* shifts traffic back to the
previous revision in one click. *Promote to production* still exists for a
manual promote. The staging URL
(`https://<app>---staging.<env-domain>`, printed in the job summary) still
shows the newest build if you want to look before it goes live.

**The rule that keeps this honest:** anything a customer can see goes behind a
flag. Things that cannot be flagged — database migrations, bug fixes to
existing behaviour, dependency upgrades — are exactly the changes that still
deserve a careful look before the push, because for those, deploy really is
release.

## Loop 3 — release to one customer at a time

Loops 1 and 2 get code into production. This one decides **who can see it** —
a separate act, and that separation is the point.

**Once, to switch the page on:** put your email in `.ops/operators` and push.
A couple of minutes later **Who sees what** appears in the rail under Settings.

**The unit is a RELEASE, not a feature.** A month's new work hangs off one
switch — `release_2026_08` — so there is one decision per batch instead of one
per feature. That is deliberate, and it has a cost worth knowing: switching a
release off withdraws *everything* in it. That is fine while a month is one or
two changes you would happily withdraw together, and it is the signal to give
something its own key (`kind: 'feature'`) the moment it is not.

**Then, for every new release — your part is one screen:**

1. Open **Who sees what**.
2. Tick your own test account next to the release. It is live for you within
   ~20 seconds. Nobody else sees it.
3. Happy? Tick a customer. Then more. Then *Everyone*.
4. Wrong? Untick. It is gone immediately — no release, no rollback, no restart.

The screen tells you both ends of the lifecycle: a banner for work that is live
but has no audience yet, and a quieter line for a release that has been on
*Everyone* long enough that its switch is now dead code. The second one is a
message for whoever writes the code — mention it and it gets removed.

**The developer's part** (mine, or whoever writes the feature):

- **Joining the current train** is the normal case: guard the new behaviour with
  `await isReleaseEnabled(tenantId, 'release_2026_08')`. Nothing else to
  declare — the key already exists and the operator already has one switch for
  it.
- **Opening a new train** (once a month, roughly): add an entry to
  `FEATURE_FLAGS` in `shared/contract.ts` — both copies, the contract-sync
  ratchet enforces it — and move `CURRENT_RELEASE` to it. Give it a `name` a
  non-developer would recognise: that string is what the screen shows.
  **Existing gates are not touched and must not be**: they go on naming the
  train they shipped in, or opening September would take August offline for
  everyone who already had it.
- A gate names its release literally. `CURRENT_RELEASE` is typed `string` for
  exactly this reason: passing it to `isReleaseEnabled` does not compile.
- Ship it. A new release arrives switched off, so merging it is safe on its own.
- **Finishing a release is deleting it.** Once the console says a release has
  been on *Everyone* for more than 14 days, delete its key from `FEATURE_FLAGS`
  and run `npm run check`: every gate that named it is now a compile error, and
  that list is the cleanup. Remove those branches, keep the new behaviour. This
  is the step every team forgets, which is why the screen now says it out loud.
- **Never gate a bug fix.** Gating a fix means choosing who keeps the broken
  behaviour. Fixes to existing behaviour ship to everyone.

## The one rule (keep migrations safe)
The 0%-traffic revision shares the database with the live one, so **migrations
must be backward-compatible**: only `CREATE TABLE` / `ADD COLUMN` (additive).
Never `DROP`/`RENAME` in the same deploy — do destructive cleanup in a *later*
deploy, after the new code is live everywhere.

## When you DON'T need Loop 2
- Pure frontend change → Loop 1 covers it; merging to main + promoting is just
  the publish step.
- Backend-only change with no new schema → still goes through Loop 2 (test the
  backend revision URL), but it's quick.

## Tips
- Keep merging straight to `main` (light process) — the safety is the
  0%-traffic revision + manual promote, not PRs.
- CI tests are a GATE, not a signal: `deploy.yml`'s `gate` job waits for the
  Tests run for that commit, and `migrate-sql` and `deploy` need it. A red suite
  does not reach production. (Image builds still run alongside — an image nobody
  deploys is harmless.) `tsc` and lint run in `check.yml` and do NOT block.
- `git revert <sha>` remains the escape hatch for any single change.
