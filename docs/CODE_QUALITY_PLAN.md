# Code-Quality Hardening Plan

> Living plan for bringing the whole codebase up to the standard already set by
> the exemplary modules (`packages/connectors`, `worker`, `services/warehouse`,
> `tableCatalog`, `safeQuery`). Driven by the 2026-07-11 software-engineering
> review (backend architecture + frontend + typing/contracts). Update the status
> column and the session log as work lands.

## Guiding rules

- **Every phase lands on green CI.** Phase 0 restores the test safety net first.
- **One phase = one (or few) focused commits**, each ending with typecheck +
  tests + lint green, then push and let CI deploy.
- **Ratchet, don't just fix.** Where a phase eliminates a bad pattern, add a
  lint rule so it can't regress — same mechanism as the existing
  `shared-trx-catch` gate. A fix without a ratchet rots.
- **Behaviour-preserving unless a fix is the point.** Refactors keep behaviour;
  the AI-output-validation and async-safety items intentionally change failure
  behaviour (fail loud instead of silent).

## Phases

| Phase | Scope | Status |
|-------|-------|--------|
| **0. Safety net** | Green the vitest suites; re-enable `test.yml` on PR/push; build connectors in CI; connector + backend tests gating | **DONE 2026-07-11** |
| **1. Crash & AI safety** | `express-async-errors` + process-level `unhandledRejection`/`uncaughtException`; Zod-gate AI outputs (star schema, dashboard spec, schema draft) before persistence. *(Inline `res.status(500)`→`next(err)` moved to Phase 3 — see note.)* | **DONE 2026-07-11** |
| **2. Config & logging** | Central `config.ts` (Zod-validated env, one name per concept — collapse `FRONTEND_URL`/`FRONTEND_BASE_URL`/`PUBLIC_APP_URL`); pino sweep of runtime `console.*`. *Ratchet: forbid raw `process.env` outside config.ts and `console.*` in services/routes.* | Not started |
| **3. Backend structure** | `startSSE(res)` helper (≈12 sites); break the `connections.ts ↔ SyncOrchestrator` cycle (move `profilingProgressPct` to a service); consolidate the `SET LOCAL app.current_tenant` primitive; finish `reqDb` migration in `dashboards.ts`/`query.ts`; **inline `res.status(500)`→`next(err)`/throw** (moved from Phase 1: with `express-async-errors` now active these are a consistency/logging issue, not a crash risk, and the clean conversion — removing nested try/catch — fits the file sweeps here); delete dead code (`utils/storage.ts`, root `shared/types.ts`). *Ratchets: forbid new internal `await import()`; forbid raw `res.status(500)` in routes.* | Not started |
| **4. Validation & contracts** | Attach the orphaned Zod schemas, then cover `products`/`semantic`/`dashboards`/`notebooks`/`pipelines`; shared DTO module + typed `api.get<T>` wrapper; migrate `Connection`/`DataProduct`/`WidgetSpec`/`DashboardSpec` to kill the live drift. *Ratchet: require `validate()` on new mutating routes.* | Not started |
| **5. Frontend quality** | `useSSE()` hook with abort-on-unmount (9 copy-paste sites); fix 23 `exhaustive-deps` disables; split `sources`/`pipelines`/`RelationshipCanvas` into component folders; `useReducer` for the 48-useState pages; adopt-or-delete the `ui/` primitives; `lib/storage.ts`; remove dead components + unused deps (`react-markdown`, `remark-gfm`, `canvg`) | Not started |
| **6. Service layer** | Split `routes/products.ts` (4590 lines) along its section dividers into route modules + a `productService` for the inline logic (`buildConnectionWarehouseSession`, the ~340-line design-stream handler) | Not started |

## Findings inventory (from the 2026-07-11 review)

Highest-risk first:
1. **No runtime shape-check on AI outputs** — `parseJson<T>` ends in a blind cast; malformed model output flows into the DB (Phase 1).
2. **No async safety net** — Express 4, no asyncHandler, no `unhandledRejection` handler; an uncaught async throw can crash the process (Phase 1).
3. **~7% validation adoption** — 205 mutating routes, 15 validated; finished schemas left unattached; 264 raw `req.body as {...}` casts (Phase 4).
4. **No API contract** — `shared/types.ts` unused; `Connection` declared 7× on the frontend; `WidgetSpec`/`DashboardSpec` already drifted (Phase 4).
5. **Config sprawl** — `process.env` in 41 files/128 sites; 3 names for the frontend URL (Phase 2).
6. **Fat routes + one circular dep** — `products.ts` (4590) etc.; `connections.ts ↔ SyncOrchestrator` via `await import()` (Phases 3 & 6).
7. **Frontend: design system bypassed** (613 raw buttons vs `ui/Button`), SSE copy-pasted 9× without unmount cancel, 48-useState pages (Phase 5).
8. **263 `console.*`; uneven `reqDb` adoption; 13 inline 500s** (Phases 2, 3, 1).

Exemplary modules to hold everything else to: `packages/connectors`, `worker`,
`services/warehouse/*`, `services/tableCatalog.ts`, `db/safeQuery.ts`,
`middleware/errorHandler.ts`, `ai/prompts/*`, `lib/api.ts` (frontend).

## Session log

- **2026-07-11 — Phase 1 complete.** Async-error safety net: `express-async-errors` (routes async throws in ~321 handlers to the error middleware instead of crashing the process) + process-level `unhandledRejection` (log+report, don't exit) and `uncaughtException` (log+graceful-shutdown+exit 1) handlers in index.ts. AI-output validation: new `ai/outputSchemas.ts` (Zod) + `parseJson<T>(raw, schema?)` now validates before returning; wired into the 6 persistence sites (schema draft ×1, dashboard spec ×3, star-schema design ×2) so malformed model output throws a clear error instead of being written to the DB. New `aiOutputSchemas.test.ts` (12 cases). Inline-500 conversions moved to Phase 3 (express-async-errors already removes the crash risk; clean conversion belongs with the file sweeps). Backend 103/103 green (one transient DB-timing flake observed once, not reproducible in 3 subsequent runs).
- **2026-07-11 — Phase 0 complete.** Diagnosed the "red suite": it was not code-broken — the local runs had no Postgres, and a real bug (`AIService.ts` called `dotenv.config({override:true})` with no `VITEST` guard, so `.env`'s `NODE_ENV=development` clobbered the test setup's `NODE_ENV=test` and `DATABASE_URL`, defeating the rate-limit skip and the health check). Fixes: guarded AIService dotenv (matching index.ts/knex.ts); disabled rate limiters under test (`skip`); updated the stale auth-refresh test to the real `{refreshToken}` body contract (+2 edge cases); made the Odoo sync-test temp cleanup Windows-safe; fixed the stale ExactOnline `gt`→`ge` incremental-filter assertion; excluded `.claude/worktrees` from vitest discovery. Re-enabled `test.yml` on PR/push, added a connectors-build step (dist is gitignored) and a connector-tests job; security audits made non-gating (dependency backlog is Phase-adjacent item B3). Result: backend 91/91, connectors 63/63 green.
