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
