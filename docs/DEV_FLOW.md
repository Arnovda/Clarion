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

**Then, for every new feature — your part is one screen:**

1. Open **Who sees what**.
2. Tick your own test account next to the feature. It is live for you within
   ~20 seconds. Nobody else sees it.
3. Happy? Tick a customer. Then more. Then *Everyone*.
4. Wrong? Untick. It is gone immediately — no release, no rollback, no restart.

**The developer's part** (mine, or whoever writes the feature):

- Add the feature to `FEATURE_FLAGS` in `shared/contract.ts` — both copies, the
  contract-sync ratchet enforces it. Give it a `name` a non-developer would
  recognise: that string is what the screen shows.
- Guard the feature: `await isFeatureEnabled(tenantId, 'my_flag')` on the
  server, `useFeature('my_flag')` on the client.
- Ship it. It arrives switched off, so merging it is safe on its own.
- **Once it has been on *Everyone* for a while, delete the flag and its
  checks.** This is the step everyone forgets. A switch nobody will ever flip
  again is a dead branch in the code.

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
- CI (`tsc` + lint + tests) runs on push as a signal; fix reds, but they don't
  block you.
- `git revert <sha>` remains the escape hatch for any single change.
