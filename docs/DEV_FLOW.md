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

## Loop 2 — fixed test URL on Azure (backend / migrations / full-stack)
For changes you can't see purely in the browser (backend logic, migrations):

1. Merge to `main`. CI builds images, runs **additive** migrations, and deploys
   backend + frontend as **new revisions at 0% traffic** — they do NOT serve
   users yet. Ready to test ~5–6 min after push (the slow Neo4j-constraints
   job now only runs when `backend/src/db/neo4j.ts` changes).
2. Open the **fixed test URL** — it never changes, so bookmark it once:
   `https://<frontend-app>---staging.<env-domain>` (the deploy job summary
   prints the exact URL on every run; same pattern for the backend API).
   The `staging` label is moved to each new revision automatically, so this
   URL always shows the newest pushed version.
3. When happy, Actions tab → **"Promote to production"** → Run workflow →
   green "Run workflow" button. This shifts 100% traffic to the newest
   revision (by name). That's go-live, ~30 seconds.

If something's wrong, just don't promote (users stay on the previous revision).
If you already promoted and it's broken: Actions tab → **"Rollback
production"** → Run workflow — shifts traffic back to the previous revision
in ~30 seconds, no rebuild.

**Caveat to know:** the test frontend calls the **live** backend (the API URL
is baked in at build time). So the frontend bookmark shows new UI against the
currently-live backend. To exercise a backend change before users see broken
UI: promote **"backend only"** first, check the live app, then promote the
frontend — and Rollback is the safety net either way.

**Why traffic is always pinned by revision NAME:** a traffic entry set to
`latest` auto-follows every future revision — the next push would go live
immediately and silently break this whole test-first model. Both deploy and
promote therefore always pin traffic to a named revision; never set
`latest=100` by hand in the portal.

## Loop 3 — release to one tenant at a time (feature flags)

Loops 1 and 2 get code into production. This one decides **who can see it**,
which is a separate act — that separation is the whole point.

1. Add a key to `FEATURE_FLAGS` in `shared/contract.ts` (both copies — the
   contract-sync ratchet enforces it). It is now off for everyone.
2. Build the feature behind the flag:
   - server: `await isFeatureEnabled(tenantId, 'my_flag')`
   - client: `const on = useFeature('my_flag')`
3. Merge and deploy normally. The code is live and invisible.
4. Open **Feature rollout** in the rail (operators only) and switch the flag to
   your own test tenant. Takes effect within ~20 seconds. No deploy.
5. Widen it — a friendly customer, then everyone — or pull it back to Nobody
   the moment it misbehaves. Pulling back is instant and costs no revision.
6. Once it has been on *Everyone* for a while, **delete the flag and its
   checks**. A flag nobody will flip again is a dead branch in the code.

Who may flip a flag is `PLATFORM_OPERATOR_EMAILS` in the backend environment —
deliberately not a tenant role, because a customer's admin must not be able to
switch on work that has not been released to them. Unset means nobody, so the
console stays shut on a deployment that has not configured it.

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
