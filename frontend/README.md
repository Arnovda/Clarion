# Clarion — frontend

Next.js 14 (App Router) + Tailwind. The rules, the current state and the folder
map live in the repository's `CLAUDE.md`; this file is only the local how-to.

```bash
npm ci
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL → a backend's /api URL
npm run dev                         # http://localhost:3000, hot reload
```

Checks the CI runs on every push and PR (`.github/workflows/test.yml`):

```bash
npm run check   # tsc --noEmit
npm run lint    # next lint — 0 errors is the bar; the remaining warnings are known
npm test        # vitest (jsdom)
PYODIDE_VENDOR=skip npm run build   # production build; the prebuild vendors Pyodide into public/pyodide/
```

`/dev/*` pages are the internal playground and 404 in a production build unless
`CLARION_DEV_PAGES=1` (the widget render gate sets it). `lib/contract.ts`,
`lib/provenance.ts` and `lib/legal/versions.ts` are byte-identical copies of their
backend twins — the `lint-contract-sync` ratchet fails the merge when they drift.
