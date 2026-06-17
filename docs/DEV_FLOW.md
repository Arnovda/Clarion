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

## Loop 2 — staging revision on Azure (backend / migrations / full-stack)
For changes you can't see purely in the browser (backend logic, migrations):

1. Merge to `main`. CI builds images, runs **additive** migrations, and deploys
   backend + frontend as **new revisions at 0% traffic** — they do NOT serve
   users yet.
2. Open the **deploy job summary** in GitHub Actions → it prints the
   per-revision test URLs (backend API + frontend). Test there against real data.
3. When happy, Actions tab → **"Promote to production"** → Run workflow. This
   shifts 100% traffic to the latest revision. That's go-live.

If something's wrong, just don't promote (users stay on the previous revision).
To roll back after a promote: re-run Promote — or shift traffic back to the
previous revision in the portal.

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
