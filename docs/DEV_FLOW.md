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

## Loop 3 — who can see it

**Right now: everyone, automatically. Nothing is gated.**

There are no customers yet, so there is no audience to protect. Every change
ships to every account the moment its deploy goes live — push to `main`, tests
pass, the revision health-checks, traffic shifts, done. That is the fastest
correct setup for a product before its first customer, and it is a deliberate
standing decision rather than an oversight: a switch guarding nobody is a second
code path that can only ever be wrong, plus one more thing to remember on every
change.

The machinery for doing it the other way is built, tested and idle: the
**Who sees what** console, the off → some customers → everyone ladder, the
audience that survives being switched off, and the lifecycle reporting. Only the
audience is missing.

**On the day the first customer signs — four steps, about an hour:**

1. Declare a train in `FEATURE_FLAGS` (`shared/contract.ts`, both copies — the
   contract-sync ratchet enforces it), e.g. `release_2026_09` with a `name` a
   non-developer would recognise: that string is what the console shows.
2. Point `CURRENT_RELEASE` at it. It is `null` today, which is what "no train is
   open" means.
3. Gate the next user-visible change with
   `await isReleaseEnabled(tenantId, 'release_2026_09')`. A gate names its
   release literally — `CURRENT_RELEASE` is typed to make passing it a compile
   error, because a gate reading "whatever is current" would take the previous
   train offline the day you open the next one.
4. Put your email in `.ops/operators` and push, if it is not there already.
   **Who sees what** appears in the rail under Settings; tick your test account
   first, then a customer, then Everyone.

**The rules that apply either way:**

- **Never gate a bug fix.** Gating a fix means choosing who keeps the broken
  behaviour. Fixes to existing behaviour ship to everyone.
- **A train is a batch.** Switching it off withdraws everything in it. Fine
  while a month is one or two changes you would withdraw together — the signal
  to give something its own key (`kind: 'feature'`) the moment it is not.
- **Finishing a release is deleting it.** Once the console says a release has
  been on *Everyone* for more than 14 days, delete its key from `FEATURE_FLAGS`
  and run `npm run check`: every gate that named it becomes a compile error, and
  that list is the cleanup. This is the step every team forgets, which is why
  the console says it out loud. (August 2026 was retired exactly this way.)

**What is missing, and it matters more without flags:** there is no alerting. If
a deploy breaks something, nothing tells you — you find out by looking. Rollback
is one click (*Rollback production*); noticing is manual. That is the next
fundamental to build, and it is more urgent than any flag work.

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
