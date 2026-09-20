# Clarion — Azure Deployment Guide

Step-by-step guide to deploy Clarion on Azure for the first time.

> **Read this first.** Production has been running since mid-2026, and two things
> this guide cannot know are recorded elsewhere:
>
> - **Day-to-day operation is GitOps, not the CLI.** Pushing to `main` builds every
>   image (tagged `main-<sha>`), runs the migrations behind a gate that requires the
>   Tests and Lint workflows to be green, deploys at 0% traffic and promotes only
>   after `/api/health` answers 200 (`.github/workflows/deploy.yml`). Production
>   settings are files under `.ops/` — see `.ops/README.md`. Rollback is the
>   **Rollback production** workflow.
> - **Terraform is not the whole picture.** Its state lives on the machine that last
>   applied it (no remote backend), the `jobs-worker` Container App was provisioned by
>   `az` from a workflow rather than by Terraform, and several controls have since
>   set values Terraform does not know about. Before any `terraform apply`, read
>   `docs/runbooks/jobs-worker-apply.md` and `docs/runbooks/disaster-recovery.md`.

---

## Prerequisites

- **Azure CLI** installed and logged in: `az login`
- **Terraform** >= 1.5 installed
- **Docker** installed (for building images)
- **GitHub** repo with secrets configured (see CI/CD section)
- An **Anthropic API key** from console.anthropic.com

---

## 1. Provision Azure Infrastructure

```bash
cd infra

# Copy and fill in your secrets
cp prod.tfvars.example prod.tfvars
# Edit prod.tfvars with real values:
#   - pg_admin_password: strong random password
#   - jwt_secret: 64-char random string (openssl rand -hex 32)
#   - anthropic_api_key: your sk-ant-... key
#   - credentials_encryption_key: 32-char random string (openssl rand -hex 16)
#   - neo4j_password: strong random password
#   - frontend_url: leave as default until you know the FQDN

terraform init
terraform plan -var-file="prod.tfvars"
terraform apply -var-file="prod.tfvars"
```

After apply completes, note the outputs:

```bash
terraform output                        # non-sensitive values
terraform output -json                  # all values including sensitive
terraform output backend_url            # e.g. https://databridge-prod-backend.niceocean-abc123.westeurope.azurecontainerapps.io
terraform output frontend_url           # e.g. https://databridge-prod-frontend.niceocean-abc123.westeurope.azurecontainerapps.io
terraform output acr_login_server       # e.g. clarionprodacr.azurecr.io
```

### Update CORS with actual frontend URL

Once you know the frontend URL from the output, update `prod.tfvars`:

```hcl
frontend_url = "https://databridge-prod-frontend.niceocean-abc123.westeurope.azurecontainerapps.io"
```

Then re-apply: `terraform apply -var-file="prod.tfvars"`

---

## 2. Build & Push Docker Images (First Time)

If not using CI/CD yet, push images manually:

```bash
# Log in to ACR
ACR=$(terraform output -raw acr_login_server)
az acr login --name $ACR

# Build and push backend
cd ../backend
docker build -t $ACR/databridge-backend:main-bootstrap .
docker push $ACR/databridge-backend:main-bootstrap

# Build and push frontend (set API URL to backend FQDN)
cd ../frontend
BACKEND_URL=$(cd ../infra && terraform output -raw backend_url)
docker build \
  --build-arg NEXT_PUBLIC_API_URL=${BACKEND_URL}/api \
  -t $ACR/databridge-frontend:main-bootstrap .
docker push $ACR/databridge-frontend:main-bootstrap

# Build and push ETL
cd ../etl
docker build -t $ACR/databridge-etl:main-bootstrap .
docker push $ACR/databridge-etl:main-bootstrap
```

Use an explicit, immutable tag for a manual push — never a mutable `:main-latest`.
Container Apps job executions serve from a node image cache, so a mutable tag once
left the sync worker running weeks-old code while every build succeeded. The CI
deploy pins every app and the sync-worker job to the per-commit `main-<sha>` tag.

After pushing, restart the Container Apps to pick up the images:

```bash
RG=$(cd ../infra && terraform output -raw resource_group)
az containerapp revision restart -g $RG -n databridge-prod-backend
az containerapp revision restart -g $RG -n databridge-prod-frontend
az containerapp revision restart -g $RG -n databridge-prod-etl
```

---

## 3. Run Database Migrations

```bash
cd ../backend

# Get the Postgres connection string from Terraform
DATABASE_URL=$(cd ../infra && terraform output -raw postgres_connection_string)

# Run Knex migrations
DATABASE_URL="$DATABASE_URL" npm run migrate:latest
```

---

## 4. Create the First Admin User

Connect to the database and insert the first admin user. The app uses bcrypt for passwords:

```bash
# Option A: Use the app's register endpoint (if enabled)
BACKEND_URL=$(cd ../infra && terraform output -raw backend_url)
curl -X POST $BACKEND_URL/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@yourcompany.com",
    "password": "YourSecurePassword123!",
    "name": "Admin User"
  }'

# Then promote to admin in Postgres:
DATABASE_URL=$(cd ../infra && terraform output -raw postgres_connection_string)
psql "$DATABASE_URL" -c "UPDATE users SET role = 'admin' WHERE email = 'admin@yourcompany.com';"
```

---

## 5. Verify Deployment

```bash
BACKEND_URL=$(cd ../infra && terraform output -raw backend_url)
FRONTEND_URL=$(cd ../infra && terraform output -raw frontend_url)

# Deep health check — every dependency the promote gate looks at
curl $BACKEND_URL/api/health
# Expected: {"ok":true,"checks":{"postgres":"ok","redis":"ok","neo4j":"ok","blob":"ok",
#            "worker_transformation":"ok","worker_bus_matrix":"ok"},"uptime":...}
# A missing dependency answers 503 and names the component; an unconfigured one
# reports "skipped" (dev/CI) and does not fail the check.

# Open frontend in browser
echo "Open: $FRONTEND_URL"
```

---

## 6. Set Up CI/CD (GitHub Actions)

Configure these GitHub repository secrets:

| Secret | Value (from `terraform output -json`) |
|--------|---------------------------------------|
| `AZURE_CREDENTIALS` | Service principal JSON (see below) |
| `ACR_LOGIN_SERVER` | `acr_login_server` output |
| `ACR_USERNAME` | `acr_admin_username` output |
| `ACR_PASSWORD` | ACR admin password (from Azure Portal) |
| `AZURE_RESOURCE_GROUP` | `resource_group` output |
| `BACKEND_APP_NAME` | `databridge-prod-backend` |
| `FRONTEND_APP_NAME` | `databridge-prod-frontend` |
| `ETL_APP_NAME` | `databridge-prod-etl` |
| `DATABASE_URL` | `postgres_connection_string` output — **the `databridge_app` (NOBYPASSRLS) login**, not the admin one; see `docs/runbooks/db-role-flip.md` |
| `PROD_API_URL` | `backend_url` output + `/api` |
| `NEO4J_URI` | `bolt://databridge-prod-neo4j:7687` |
| `NEO4J_PASSWORD` | Your neo4j_password from tfvars |

The workflows under `.github/workflows/` read further secrets for the GitOps
controls (alerts, prod-logs, db-role, …); each workflow lists the ones it needs at
the top of its file.

### Create Azure Service Principal

```bash
az ad sp create-for-rbac \
  --name "clarion-github-deploy" \
  --role contributor \
  --scopes /subscriptions/YOUR_SUBSCRIPTION_ID/resourceGroups/databridge-prod-rg \
  --sdk-auth
```

Copy the JSON output as the `AZURE_CREDENTIALS` secret.

---

## 7. Set Up Terraform Remote State (Recommended)

For production, store Terraform state in Azure Storage instead of locally:

```bash
# Create storage account for state
az group create -n databridge-tfstate-rg -l westeurope
az storage account create -n databridgetfstate -g databridge-tfstate-rg -l westeurope --sku Standard_LRS
az storage container create -n tfstate --account-name databridgetfstate
```

Then uncomment the `backend "azurerm"` block in `infra/main.tf` and run `terraform init -migrate-state`.

---

## What runs in production

| Component | Kind | Always on? |
|-----------|------|------------|
| `databridge-prod-backend` | Container App — API + the identity-requiring queues | scale-to-zero (`min_replicas 0`) |
| `databridge-prod-jobs-worker` | Container App — transformation / maintenance queues (`ROLE=worker`) | yes, 1 replica (BullMQ needs a running worker to fire scheduled jobs) |
| `databridge-prod-sync-worker` | Container Apps **Job** — one execution per source sync | per execution |
| `databridge-prod-frontend` | Container App — Next.js | scale-to-zero |
| `databridge-prod-neo4j` | Container App — knowledge graph, internal ingress only | yes |
| `databridge-prod-redis` | Container App — BullMQ + caches (`noeviction`, ephemeral by design) | yes |
| `databridge-prod-etl` | Container App — legacy Python ETL for the direct-database path | scale-to-zero |
| PostgreSQL Flexible Server | B_Standard_B1ms, 14-day PITR | yes |
| Blob Storage + File Share | warehouse (per-tenant containers) + Neo4j data | — |

Costs: the measured bill and the decisions taken on it are in `docs/AZURE_COSTS.md`;
the always-on containers are where the money goes.

---

## Onboarding a New Customer (Tenant)

1. The customer self-registers at `/register` (email verification is enforced when an
   email provider is configured), which creates their tenant with the default seat,
   source and AI-token caps — or a platform operator invites them from `/admin/tenants`.
2. Their admin connects a source on **Sources**, syncs it and clicks **Analyse**.
3. **Build** creates the topics (star schemas) from the connector's template or the
   AI designer; definitions are confirmed on **Review** / the **Catalog**.
4. Everyone can then ask questions on **Ask**, and dashboards, subjects and the
   morning brief work from the same data.

Operators (`PLATFORM_OPERATOR_EMAILS`, set through `.ops/operators`) manage tenants,
caps, suspension and support sessions on `/admin/tenants` and `/admin/ops`.

---

## Troubleshooting

### Container Apps logs
```bash
az containerapp logs show -g databridge-prod-rg -n databridge-prod-backend --follow
az containerapp logs show -g databridge-prod-rg -n databridge-prod-neo4j --follow
```

### Restart a service
```bash
az containerapp revision restart -g databridge-prod-rg -n databridge-prod-backend
```

### Scale manually
```bash
az containerapp update -g databridge-prod-rg -n databridge-prod-backend --min-replicas 2 --max-replicas 5
```

### Connect to Postgres
```bash
DATABASE_URL=$(cd infra && terraform output -raw postgres_connection_string)
psql "$DATABASE_URL"
```

### Check Application Insights
Go to Azure Portal > Application Insights > `databridge-prod-insights` > Live Metrics

### Read production logs without a laptop
Edit `.ops/prod-logs` on `main` (see `.ops/README.md`): the workflow runs the
signature queries against Log Analytics and writes the report into the run summary.
