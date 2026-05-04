# Clarion — Azure Deployment Guide

Step-by-step guide to deploy Clarion on Azure for the first time.

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
docker build -t $ACR/databridge-backend:main-latest .
docker push $ACR/databridge-backend:main-latest

# Build and push frontend (set API URL to backend FQDN)
cd ../frontend
BACKEND_URL=$(cd ../infra && terraform output -raw backend_url)
docker build \
  --build-arg NEXT_PUBLIC_API_URL=${BACKEND_URL}/api \
  -t $ACR/databridge-frontend:main-latest .
docker push $ACR/databridge-frontend:main-latest

# Build and push ETL
cd ../etl
docker build -t $ACR/databridge-etl:main-latest .
docker push $ACR/databridge-etl:main-latest
```

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

# Health check
curl $BACKEND_URL/api/health
# Expected: {"ok":true,"checks":{"postgres":"ok"},...}

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
| `DATABASE_URL` | `postgres_connection_string` output |
| `PROD_API_URL` | `backend_url` output + `/api` |
| `NEO4J_URI` | `bolt://databridge-prod-neo4j:7687` |
| `NEO4J_PASSWORD` | Your neo4j_password from tfvars |

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

## Monthly Cost Estimate (West Europe)

| Resource | SKU | Estimate |
|----------|-----|----------|
| PostgreSQL Flexible | B_Standard_B1ms | ~25 EUR |
| Redis Cache | Basic C0 | ~15 EUR |
| Container Apps (backend) | 0.5 vCPU, 1 GB | ~20 EUR |
| Container Apps (frontend) | 0.25 vCPU, 0.5 GB | ~10 EUR |
| Container Apps (neo4j) | 0.5 vCPU, 1 GB | ~20 EUR |
| Container Apps (etl) | Scale-to-zero | ~2 EUR |
| Container Registry | Basic | ~5 EUR |
| Storage (Blob + File Share) | Standard LRS | ~2 EUR |
| Application Insights | Pay-as-you-go | ~5 EUR |
| **Total** | | **~105 EUR/month** |

---

## Onboarding a New Customer (Tenant)

1. Log in as admin at the frontend URL
2. Go to **Users** > **Invite** to create the customer's admin account
3. Customer logs in, goes to **Setup** to connect their database
4. Admin reviews and approves the AI-generated semantic layer
5. Customer can now query their data via the chat interface

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
