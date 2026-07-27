# `.ops/` — GitOps controls for production settings

Files here are **operational switches**, not application config. Editing one on
`main` triggers a workflow that applies it to the running Azure resources.

## `warehouse-container-mode`

Contains exactly one word: `per-tenant` or `shared`.

| Value | Meaning |
|---|---|
| `per-tenant` | One Azure Blob container per tenant (`tenant-<id>`). A **hard** storage boundary: a worker SAS scoped to `tenant-42` physically cannot touch `tenant-43`. GDPR offboarding = one container delete. |
| `shared` | One `warehouse` container for everyone, tenants separated by a `tenant_<id>/` path prefix that is enforced **only in application code**. The legacy mode, kept as the rollback path. |

Edit → commit → push to `main`. The **Warehouse container mode** workflow
(`.github/workflows/warehouse-container-mode.yml`) sets the backend's
`WAREHOUSE_CONTAINER_MODE` env var and shifts traffic to the new revision.

**Switching is safe in both directions.** It only changes where *new* writes
land; existing data keeps reading because `warehouse_path` / `delta_path` are
stored as absolute URIs, and the DuckDB session can read both the shared
container and per-tenant containers.

`infra/variables.tf` (`warehouse_container_mode`) remains the source of truth
for a **fresh** environment — keep the two in agreement, since a
`terraform apply` would otherwise reassert the Terraform value.

Details and the validation checklist: `docs/runbooks/per-tenant-container-flip.md`.

## `provision-jobs-worker`

Contains exactly one word: `create`, `delete` or `noop`.

| Value | Meaning |
|---|---|
| `create` | Create (or re-sync) the `…-jobs-worker` Container App: same image and configuration as the backend, no ingress, 1 replica. Heavy DuckDB transformations move there so they stop competing with dashboard queries. |
| `delete` | Remove the worker and hand every queue back to the API. The rollback. |
| `noop` | Do nothing. |

`create` is **idempotent** — running it again updates the existing worker to the
backend's current image and re-applies the queue split. That is the supported way
to move the worker onto a newer build: the worker clones the backend's image at
run time, so re-running it after a deploy brings the two back in step.

Any edit to the file re-triggers the workflow, including a comment line — the
value is read from the first non-comment line.

## `infra-preflight`

Free-text. Editing it runs a **read-only** probe that reports which roles the
deploy identity holds, whether the backend's configuration can be cloned, whether
Terraform state exists in the subscription, and the image + health of both apps.
It changes nothing; use it to check the state of production at any time.
