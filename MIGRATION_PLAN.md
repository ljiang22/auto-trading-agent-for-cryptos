# SentiEdge — Comprehensive Cross-Account AWS Migration Plan

> **Projects:** Django Backend + Next.js Frontend + AI Agent (Node.js/Express)
> **From:** 3 EC2 instances + CodeDeploy + localhost MySQL + SQLite
> **To:** ECS/Fargate + ALB + RDS MySQL + Amazon DocumentDB (MongoDB) + S3 + CloudWatch
> **DNS:** Third-party provider (not Route53)
> **Cutover:** Near-zero downtime via DNS switch
> **Created:** March 15, 2026

---

## Before You Start — Project Overview

### The Three Projects

| Project | Tech Stack | Current Hosting | Database | Domain |
|---------|-----------|----------------|----------|--------|
| **Backend** (`SentiEdge-Django-Server`) | Django + Gunicorn (port 8000) | EC2 + CodeDeploy | MySQL 5.7 on localhost | `api.sentiedge.ai` |
| **Frontend** (`Sentiedge-App`) | Next.js 14 + TypeScript (port 80) | EC2 + CodeDeploy + PM2 | None (calls backend API) | `www.sentiedge.ai` |
| **AI Agent** (`senti-agent-0428`) | Node.js 23 + Express + TypeScript (port 3000) | EC2 + PM2 | SQLite (19 tables, vector embeddings) | `agent.sentiedge.ai` |

### Target Architecture

```
                Third-Party DNS
         ┌──────────┼──────────┐
         │          │          │
  api.sentiedge.ai  │  agent.sentiedge.ai
         │   www.sentiedge.ai  │
         │          │          │
         ▼          ▼          ▼
    ┌────────────────────────────────┐
    │   Application Load Balancer    │
    │   HTTPS :443 (ACM certs)       │
    │   Host-based routing           │
    │   Public subnets (2+ AZ)       │
    └──┬─────────┬─────────┬────────┘
       │         │         │
       ▼         ▼         ▼
   ┌────────┐ ┌────────┐ ┌────────┐
   │ECS     │ │ECS     │ │ECS     │
   │Backend │ │Frontend│ │Agent   │
   │:8000   │ │:3000   │ │:3000   │
   │Fargate │ │Fargate │ │Fargate │
   │Private │ │Private │ │Private │
   └───┬────┘ └────────┘ └───┬────┘
       │                      │
       ▼                      ▼
   ┌────────┐          ┌──────────┐
   │RDS     │          │DocumentDB│
   │MySQL   │          │(MongoDB) │
   │Multi-AZ│          │Multi-AZ  │
   │Private │          │Private   │
   └────────┘          └──────────┘
```

### Database Strategy (Best Practice)

**Hybrid approach: RDS MySQL + Amazon DocumentDB (MongoDB-compatible)**

| Data | Database | Why |
|------|----------|-----|
| Django backend (users, stocks, portfolios) | **RDS MySQL** | Relational data with foreign keys, Django ORM works best with SQL |
| AI Agent (conversations, memories, knowledge, subscriptions) | **Amazon DocumentDB** (MongoDB) | Document-oriented data, JSON-heavy, the agent already has built-in MongoDB support via `MONGODB_CONNECTION_STRING` |

**Why not all-MongoDB for Django?**
- Django's ORM, admin, auth, and migrations are built for relational databases
- Adapters like `djongo` are limited and poorly maintained
- Your Django models (UserInfo, StockDaily, CompanyTopInvestors) have relational constraints, foreign keys, and unique indexes that fit SQL naturally
- Forcing MongoDB would require rewriting ORM queries, losing Django admin, and breaking migrations

**Why MongoDB for the Agent?**
- The agent already has a `MONGODB_CONNECTION_STRING` environment variable and MongoDB adapter support built in
- Agent data is document-oriented: JSON-heavy memories, task chains, knowledge chunks
- Vector embeddings (in `memories` and `knowledge` tables) are stored as BLOBs — MongoDB stores these as Binary, and the agent already handles vector search in application code
- Switching from SQLite to MongoDB requires only setting an env var — no code changes

### Placeholders Used Throughout

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `<region>` | AWS region | `us-east-1` |
| `<target-account-id>` | New AWS account ID | `123456789012` |
| `<profile-target>` | AWS CLI profile | `sentiedge-target` |
| `<dns-provider-ns>` | Your DNS provider nameserver | `ns1.example.com` |
| `<rds-endpoint>` | RDS MySQL endpoint | `sentiedge-db.xxx.rds.amazonaws.com` |
| `<docdb-endpoint>` | DocumentDB endpoint | `sentiedge-docdb.xxx.docdb.amazonaws.com` |

---

## Step 1: Externalize Secrets from All Three Projects

> **Why:** Secrets must come from environment variables or AWS Secrets Manager — never hardcoded in code. This blocks all later steps.

### 1.1 Backend (Django) — requires changes

The backend has hardcoded secrets in `sentiedge_django_server/my_secret.py`:

| Secret | Move to env var |
|--------|----------------|
| Django SECRET_KEY | `DJANGO_SECRET_KEY` |
| MySQL username | `DB_USER` |
| MySQL password | `DB_PASSWORD` |
| Gmail SMTP email | `SMTP_USER` |
| Gmail SMTP password | `SMTP_PASSWORD` |
| SMTP port | `SMTP_PORT` |

Update `sentiedge_django_server/production_settings.py`:

```python
import os

SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.mysql",
        "NAME": os.environ.get("DB_NAME", "sentiedge_072225"),
        "USER": os.environ["DB_USER"],
        "PASSWORD": os.environ["DB_PASSWORD"],
        "HOST": os.environ.get("DB_HOST", "127.0.0.1"),
        "PORT": os.environ.get("DB_PORT", "3306"),
    }
}
```

Update `api/utils/email_utils.py`:

```python
import os
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ["SMTP_USER"]
SMTP_PASSWORD = os.environ["SMTP_PASSWORD"]
```

Also parameterize domain settings:

```python
API_DOMAIN = os.environ.get("API_DOMAIN", "api.sentiedge.ai")
APP_SIGN_UP_URL = os.environ.get("APP_SIGN_UP_URL", "https://agent.sentiedge.ai/signup")
```

### 1.2 Frontend (Next.js) — already env-driven ✅

The frontend already uses environment variables:

- `.env.production`: `NEXT_PUBLIC_APP_URL=https://www.sentiedge.ai`, `NEXT_PUBLIC_API_BASE_URL=https://api.sentiedge.ai/api`
- These are read via `libs/constants.jsx`

**No code changes needed.** Just ensure the correct `.env.production` is used at build time.

### 1.3 AI Agent — already env-driven ✅

The agent already uses `.env` / `.env.production` for all config:

- `MONGODB_CONNECTION_STRING` (already supported for MongoDB)
- `OPENAI_API_KEY`, `PRODUCTION_OPENAI_API_KEY`
- `COINMARKETCAP_API_KEY`, `NEWS_API_KEY`
- Stripe keys, S3 config, SMTP config

**No code changes needed.** Secrets will be injected via ECS task definition.

### 1.4 Verify all three apps work with env-only inputs

**Backend:**
```bash
export DJANGO_SECRET_KEY="<key>" DB_USER="<user>" DB_PASSWORD="<pass>" \
  DB_HOST="127.0.0.1" SMTP_USER="<email>" SMTP_PASSWORD="<pass>"
python manage.py check --deploy
```

**Frontend:**
```bash
NEXT_PUBLIC_API_BASE_URL=https://api.sentiedge.ai/api npm run build
```

**Agent:**
```bash
# Agent already reads from .env — just confirm it starts
pnpm start
```

### How to verify Step 1 is done

- [ ] Backend starts without importing `my_secret.py`
- [ ] Frontend builds with env vars for API URL
- [ ] Agent starts with env vars (no hardcoded secrets)

### If something goes wrong

Revert code changes. No infrastructure has been touched yet.

---

## Step 2: Set Up the New AWS Account Foundation

> **Why:** The new account needs networking, permissions, container registries, secrets storage, SSL certificates, and S3 access for all three projects.

### 2.1 AWS CLI profile

```bash
aws configure --profile <profile-target>
aws sts get-caller-identity --profile <profile-target>
```

### 2.2 VPC and networking

| Resource | CIDR / Details | Purpose |
|----------|---------------|---------|
| VPC | `10.0.0.0/16` | Isolated network |
| Public Subnet A | `10.0.1.0/24` (AZ-a) | ALB |
| Public Subnet B | `10.0.2.0/24` (AZ-b) | ALB |
| Private Subnet A | `10.0.10.0/24` (AZ-a) | ECS tasks + databases |
| Private Subnet B | `10.0.20.0/24` (AZ-b) | ECS tasks + databases |
| Internet Gateway | Attached to VPC | Public internet |
| NAT Gateway | Public Subnet A | Outbound for private subnets |

### 2.3 Security groups

| Security Group | Inbound Rules | Purpose |
|---------------|---------------|---------|
| `sg-alb` | TCP 443, TCP 80 from `0.0.0.0/0` | ALB |
| `sg-ecs-backend` | TCP 8000 from `sg-alb` | Django backend |
| `sg-ecs-frontend` | TCP 3000 from `sg-alb` | Next.js frontend |
| `sg-ecs-agent` | TCP 3000 from `sg-alb` | AI agent |
| `sg-rds` | TCP 3306 from `sg-ecs-backend` | RDS MySQL |
| `sg-docdb` | TCP 27017 from `sg-ecs-agent` | DocumentDB |

### 2.4 IAM roles

| Role | Trust | Policies |
|------|-------|----------|
| `ecsTaskExecutionRole` | `ecs-tasks.amazonaws.com` | ECS execution, Secrets Manager read, ECR pull, CloudWatch Logs |
| `ecsTaskRole-backend` | `ecs-tasks.amazonaws.com` | Secrets Manager read (backend secrets) |
| `ecsTaskRole-frontend` | `ecs-tasks.amazonaws.com` | S3 read (`sentiscoredata` bucket) |
| `ecsTaskRole-agent` | `ecs-tasks.amazonaws.com` | Secrets Manager read, S3 read/write (`sentiedge24-new` bucket) |
| `cicd-deploy-role` | GitHub Actions / CodeBuild | ECR push, ECS deploy for all 3 services |

### 2.5 ECR repositories

```bash
for repo in sentiedge-backend sentiedge-frontend sentiedge-agent; do
  aws ecr create-repository --repository-name $repo \
    --region <region> --profile <profile-target>
done
```

### 2.6 CloudWatch log groups

```bash
for group in /ecs/sentiedge-backend /ecs/sentiedge-frontend /ecs/sentiedge-agent; do
  aws logs create-log-group --log-group-name $group \
    --region <region> --profile <profile-target>
done
```

### 2.7 Secrets Manager

Store ALL secrets for all three projects:

```bash
# Backend secrets
aws secretsmanager create-secret --name sentiedge/django-secret-key \
  --secret-string "<value>" --region <region> --profile <profile-target>
aws secretsmanager create-secret --name sentiedge/db-password \
  --secret-string "<value>" --region <region> --profile <profile-target>
aws secretsmanager create-secret --name sentiedge/smtp-password \
  --secret-string "<value>" --region <region> --profile <profile-target>

# Agent secrets
aws secretsmanager create-secret --name sentiedge/openai-api-key \
  --secret-string "<value>" --region <region> --profile <profile-target>
aws secretsmanager create-secret --name sentiedge/coinmarketcap-api-key \
  --secret-string "<value>" --region <region> --profile <profile-target>
aws secretsmanager create-secret --name sentiedge/news-api-key \
  --secret-string "<value>" --region <region> --profile <profile-target>
aws secretsmanager create-secret --name sentiedge/stripe-secret-key \
  --secret-string "<value>" --region <region> --profile <profile-target>
aws secretsmanager create-secret --name sentiedge/docdb-password \
  --secret-string "<value>" --region <region> --profile <profile-target>
```

### 2.8 ACM certificates

Request certificates for all three domains:

```bash
aws acm request-certificate --domain-name api.sentiedge.ai \
  --validation-method DNS --region <region> --profile <profile-target>

aws acm request-certificate --domain-name sentiedge.ai \
  --subject-alternative-names "www.sentiedge.ai" \
  --validation-method DNS --region <region> --profile <profile-target>

aws acm request-certificate --domain-name agent.sentiedge.ai \
  --validation-method DNS --region <region> --profile <profile-target>
```

Add the DNS validation CNAME records in your third-party DNS provider. Wait for all certs to become `ISSUED`.

### 2.9 S3 bucket access

Your frontend reads from `sentiscoredata` and your agent reads research reports from `sentiedge24-new`. Legacy data may still be in `sentiedge24` in the old account. Two options:

**Option A: Cross-account bucket policy (faster)**
Add a bucket policy on the old account's buckets allowing the new account's ECS task roles:
```json
{
  "Effect": "Allow",
  "Principal": {"AWS": "arn:aws:iam::<target-account-id>:role/ecsTaskRole-frontend"},
  "Action": ["s3:GetObject", "s3:ListBucket"],
  "Resource": ["arn:aws:s3:::sentiscoredata", "arn:aws:s3:::sentiscoredata/*"]
}
```

**Option B: Replicate buckets to new account (cleaner long-term)**
```bash
aws s3 sync s3://sentiscoredata s3://sentiscoredata-new --profile <profile-target>
aws s3 sync s3://sentiedge24 s3://sentiedge24-new --profile <profile-target>
```
Then update env vars to point to the new bucket names.

### How to verify Step 2 is done

- [ ] VPC with 2 public + 2 private subnets
- [ ] 6 security groups with correct rules
- [ ] 3 ECR repositories exist
- [ ] 3 CloudWatch log groups exist
- [ ] All secrets in Secrets Manager
- [ ] 3 ACM certificates `ISSUED`
- [ ] S3 access configured (cross-account or replicated)
- [ ] IAM roles created

### If something goes wrong

Delete and recreate. Nothing is live yet.

---

## Step 3: Set Up the Databases

> **Why:** You need managed RDS MySQL for the Django backend and Amazon DocumentDB (MongoDB-compatible) for the AI Agent, both in private subnets with Multi-AZ for reliability.

### 3.1 Provision RDS MySQL (for Django backend)

```bash
# DB subnet group
aws rds create-db-subnet-group \
  --db-subnet-group-name sentiedge-db-subnets \
  --db-subnet-group-description "Private subnets for RDS" \
  --subnet-ids <private-subnet-a-id> <private-subnet-b-id> \
  --region <region> --profile <profile-target>

# RDS instance
aws rds create-db-instance \
  --db-instance-identifier sentiedge-mysql \
  --db-instance-class db.t3.medium \
  --engine mysql --engine-version "5.7" \
  --master-username <db-user> \
  --master-user-password <db-password> \
  --allocated-storage 20 --multi-az \
  --db-subnet-group-name sentiedge-db-subnets \
  --vpc-security-group-ids <sg-rds-id> \
  --backup-retention-period 7 --no-publicly-accessible \
  --region <region> --profile <profile-target>
```

Wait for `available`, note the **RDS endpoint**.

### 3.2 Provision Amazon DocumentDB (for AI Agent)

```bash
# DocumentDB subnet group
aws docdb create-db-subnet-group \
  --db-subnet-group-name sentiedge-docdb-subnets \
  --db-subnet-group-description "Private subnets for DocumentDB" \
  --subnet-ids <private-subnet-a-id> <private-subnet-b-id> \
  --region <region> --profile <profile-target>

# DocumentDB cluster
aws docdb create-db-cluster \
  --db-cluster-identifier sentiedge-docdb \
  --engine docdb \
  --master-username agentadmin \
  --master-user-password <docdb-password> \
  --vpc-security-group-ids <sg-docdb-id> \
  --db-subnet-group-name sentiedge-docdb-subnets \
  --storage-encrypted \
  --region <region> --profile <profile-target>

# Add instances (at least 2 for Multi-AZ)
aws docdb create-db-instance \
  --db-instance-identifier sentiedge-docdb-1 \
  --db-instance-class db.t3.medium \
  --db-cluster-identifier sentiedge-docdb \
  --engine docdb \
  --region <region> --profile <profile-target>

aws docdb create-db-instance \
  --db-instance-identifier sentiedge-docdb-2 \
  --db-instance-class db.t3.medium \
  --db-cluster-identifier sentiedge-docdb \
  --engine docdb \
  --availability-zone <region>b \
  --region <region> --profile <profile-target>
```

Wait for `available`, note the **DocumentDB cluster endpoint**.

### 3.3 Download the DocumentDB TLS certificate

DocumentDB requires TLS. Download the CA bundle:

```bash
wget https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

You'll need this in the agent's container.

### 3.4 Important: Vector Embeddings

The agent stores vector embeddings as BLOBs in `memories.embedding` and `knowledge.embedding`.

- **DocumentDB** does NOT support native vector search (unlike MongoDB Atlas)
- **Your agent already handles vector search in application code** (using `better-sqlite3` with custom similarity functions)
- When using MongoDB/DocumentDB, embeddings are stored as Binary data, and the agent's code performs similarity search in-memory
- This works fine for moderate data volumes. If you need scalable vector search later, consider adding **Amazon OpenSearch** or switching to **MongoDB Atlas** with Vector Search

### How to verify Step 3 is done

- [ ] RDS MySQL instance `available`, endpoint noted
- [ ] DocumentDB cluster `available`, cluster endpoint noted
- [ ] Both accessible only from private subnets via correct security groups
- [ ] DocumentDB TLS cert downloaded

---

## Step 4: Migrate MySQL Data to RDS

> **Why:** Your Django backend's data needs to move from the EC2 localhost MySQL to the managed RDS instance.

### 4.1 Export from source EC2

```bash
# On the source EC2
mysqldump -u <db-user> -p --single-transaction --routines --triggers \
  sentiedge_072225 > sentiedge_dump.sql
gzip sentiedge_dump.sql
```

### 4.2 Transfer and import to RDS

Transfer the dump to a bastion host (or any instance in the private subnet):

```bash
scp sentiedge_dump.sql.gz ec2-user@<bastion-ip>:/tmp/
```

On the bastion:

```bash
gunzip /tmp/sentiedge_dump.sql.gz
mysql -h <rds-endpoint> -u <db-user> -p -e "CREATE DATABASE sentiedge_072225;"
mysql -h <rds-endpoint> -u <db-user> -p sentiedge_072225 < /tmp/sentiedge_dump.sql
```

### 4.3 Validate data parity

On both source and target, run:

```sql
SELECT table_name, table_rows FROM information_schema.tables
WHERE table_schema = 'sentiedge_072225' ORDER BY table_name;
```

Compare row counts for all tables, especially `user_info`, `stock_daily`, `stock_company_info`.

### How to verify Step 4 is done

- [ ] Database `sentiedge_072225` exists on RDS with all tables
- [ ] Row counts match source for every table
- [ ] Can connect from private subnet to RDS on port 3306

### If something goes wrong

Drop and re-import. Source is untouched.

---

## Step 5: Migrate SQLite Data to DocumentDB (MongoDB)

> **Why:** The AI agent's SQLite database (19 tables) needs to move to the managed DocumentDB so it persists reliably and survives container restarts.

### 5.1 Understand the agent's MongoDB support

The agent already has built-in MongoDB adapter support. When you set `MONGODB_CONNECTION_STRING`, it automatically uses MongoDB instead of SQLite. The agent will create all collections and indexes automatically on first startup.

### 5.2 Export existing SQLite data

On the source EC2 where the agent runs:

```bash
cd /path/to/senti-agent-0428/agent/data

# Export each table as JSON
for table in accounts rooms participants memories relationships \
  goals logs knowledge action_cache favorite_taskchains \
  shared_taskchains cache subscription_events user_subscriptions \
  token_usage referral_codes referrals user_referral_codes; do
  sqlite3 -json db.sqlite "SELECT * FROM $table;" > ${table}.json
  echo "Exported $table: $(cat ${table}.json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))') records"
done
```

### 5.3 Handle vector embeddings

The `memories` and `knowledge` tables contain `embedding` columns stored as BLOBs (binary float arrays). These need conversion:

```python
#!/usr/bin/env python3
"""convert_embeddings.py — Convert SQLite BLOB embeddings to MongoDB-compatible format"""
import sqlite3
import json
import struct
import base64

conn = sqlite3.connect('db.sqlite')

for table in ['memories', 'knowledge']:
    rows = conn.execute(f"SELECT * FROM {table}").fetchall()
    cols = [desc[0] for desc in conn.execute(f"SELECT * FROM {table} LIMIT 0").description]
    
    docs = []
    for row in rows:
        doc = {}
        for col, val in zip(cols, row):
            if col == 'embedding' and val is not None:
                # Convert BLOB to base64 for JSON transport
                doc[col] = {"$binary": {"base64": base64.b64encode(val).decode(), "subType": "00"}}
            else:
                doc[col] = val
        docs.append(doc)
    
    with open(f'{table}_mongo.json', 'w') as f:
        json.dump(docs, f)
    print(f"Converted {table}: {len(docs)} records")

conn.close()
```

### 5.4 Import into DocumentDB

From a bastion host that can reach DocumentDB:

```bash
# Connect with TLS
mongosh --tls --host <docdb-endpoint>:27017 \
  --tlsCAFile global-bundle.pem \
  --username agentadmin --password <docdb-password>

# In the shell, create the database
use elizaAgent
```

Import each collection:

```bash
for collection in accounts rooms participants memories relationships \
  goals logs knowledge action_cache favorite_taskchains \
  shared_taskchains cache subscription_events user_subscriptions \
  token_usage referral_codes referrals user_referral_codes; do
  
  mongoimport --host <docdb-endpoint>:27017 \
    --tls --tlsCAFile global-bundle.pem \
    --username agentadmin --password <docdb-password> \
    --db elizaAgent --collection $collection \
    --jsonArray --file ${collection}.json
done
```

For memories and knowledge (with converted embeddings):

```bash
mongoimport --host <docdb-endpoint>:27017 \
  --tls --tlsCAFile global-bundle.pem \
  --username agentadmin --password <docdb-password> \
  --db elizaAgent --collection memories \
  --jsonArray --file memories_mongo.json

mongoimport --host <docdb-endpoint>:27017 \
  --tls --tlsCAFile global-bundle.pem \
  --username agentadmin --password <docdb-password> \
  --db elizaAgent --collection knowledge \
  --jsonArray --file knowledge_mongo.json
```

### 5.5 Create indexes

```javascript
// In mongosh connected to DocumentDB
use elizaAgent

// Core indexes matching SQLite schema
db.memories.createIndex({ agentId: 1, roomId: 1, type: 1 })
db.memories.createIndex({ agentId: 1, createdAt: -1 })
db.knowledge.createIndex({ agentId: 1, isMain: 1 })
db.knowledge.createIndex({ agentId: 1, originalId: 1 })
db.participants.createIndex({ agentId: 1, roomId: 1 })
db.participants.createIndex({ agentId: 1, userId: 1 })
db.rooms.createIndex({ agentId: 1 })
db.token_usage.createIndex({ userId: 1, timestamp: -1 })
db.subscription_events.createIndex({ userId: 1, createdAt: -1 })
db.user_subscriptions.createIndex({ userId: 1 }, { unique: true })
db.referral_codes.createIndex({ referralCode: 1 }, { unique: true })
db.favorite_taskchains.createIndex({ userId: 1, agentId: 1, chainId: 1 }, { unique: true })
db.shared_taskchains.createIndex({ shareCode: 1 }, { unique: true })
db.cache.createIndex({ key: 1, agentId: 1 }, { unique: true })
db.action_cache.createIndex({ actionName: 1, expiresAt: 1 })
```

### 5.6 Validate data parity

```javascript
// In mongosh
use elizaAgent
db.getCollectionNames().forEach(c => {
  print(c + ": " + db[c].countDocuments() + " documents")
})
```

Compare with SQLite:
```bash
for table in accounts rooms participants memories ...; do
  echo "$table: $(sqlite3 db.sqlite "SELECT COUNT(*) FROM $table;")"
done
```

### How to verify Step 5 is done

- [ ] All 19 collections exist in DocumentDB with correct document counts
- [ ] Indexes created on key fields
- [ ] Embedding data (memories, knowledge) preserved as Binary
- [ ] Sample documents spot-checked for data integrity

### If something goes wrong

Drop collections and re-import. Source SQLite is untouched.

---

## Step 6: Containerize All Three Applications

> **Why:** ECS Fargate runs containers. Each project needs a Docker image.

### 6.1 Backend (Django) — `Dockerfile`

Create `Dockerfile` in `SentiEdge-Django-Server/`:

```dockerfile
FROM python:3.10-slim

RUN apt-get update && apt-get install -y \
    gcc default-libmysqlclient-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN DJANGO_SECRET_KEY=build DB_USER=build DB_PASSWORD=build \
    DB_HOST=localhost SMTP_USER=build SMTP_PASSWORD=build \
    python manage.py collectstatic --noinput || true

EXPOSE 8000
CMD ["gunicorn", "sentiedge_django_server.wsgi:application", \
     "--bind", "0.0.0.0:8000", "--workers", "3", "--timeout", "120"]
```

### 6.2 Frontend (Next.js) — `Dockerfile`

Create `Dockerfile` in `Sentiedge-App/`:

```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# NEXT_PUBLIC_* vars must be set at BUILD time
ARG NEXT_PUBLIC_APP_URL=https://www.sentiedge.ai
ARG NEXT_PUBLIC_API_BASE_URL=https://api.sentiedge.ai/api
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
```

**Important:** `NEXT_PUBLIC_*` variables are baked into the JavaScript bundle at build time. Pass them as `--build-arg` when building:

```bash
docker build \
  --build-arg NEXT_PUBLIC_APP_URL=https://www.sentiedge.ai \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.sentiedge.ai/api \
  -t sentiedge-frontend:v1 .
```

### 6.3 AI Agent — single image serves both backend API and frontend UI

The agent Dockerfile builds both the backend and the Vite/React frontend into a single image. The Express server serves the frontend static files and handles SPA routing automatically (via `express.static` + catch-all fallback in `packages/client-direct/src/index.ts`).

The Dockerfile already downloads the DocumentDB TLS cert at build time:

```dockerfile
RUN curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    -o /app/global-bundle.pem
```

The `MONGODB_CONNECTION_STRING` should include `?tls=true&tlsCAFile=/app/global-bundle.pem`:

```
mongodb://agentadmin:<password>@<docdb-endpoint>:27017/elizaAgent?tls=true&tlsCAFile=/app/global-bundle.pem&replicaSet=rs0&readPreference=secondaryPreferred
```

**Important:** `VITE_*` and `SERVER_*` variables are baked into the JS bundle at build time. Pass them as `--build-arg`:

### 6.4 Build and push all images to ECR

```bash
# Login to ECR
aws ecr get-login-password --region <region> --profile <profile-target> | \
  docker login --username AWS --password-stdin \
  <target-account-id>.dkr.ecr.<region>.amazonaws.com

# Backend
cd SentiEdge-Django-Server
docker build -t sentiedge-backend:v1 .
docker tag sentiedge-backend:v1 <target-account-id>.dkr.ecr.<region>.amazonaws.com/sentiedge-backend:v1
docker push <target-account-id>.dkr.ecr.<region>.amazonaws.com/sentiedge-backend:v1

# Frontend
cd ../Sentiedge-App
docker build \
  --build-arg NEXT_PUBLIC_APP_URL=https://www.sentiedge.ai \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.sentiedge.ai/api \
  -t sentiedge-frontend:v1 .
docker tag sentiedge-frontend:v1 <target-account-id>.dkr.ecr.<region>.amazonaws.com/sentiedge-frontend:v1
docker push <target-account-id>.dkr.ecr.<region>.amazonaws.com/sentiedge-frontend:v1

# Agent (builds both backend API + frontend UI in one image)
cd ../AI-agents/senti-agent-0428
docker build \
  --build-arg SERVER_BASE_URL=https://agent.sentiedge.ai \
  --build-arg VITE_APP_HOST_DOMAIN=https://agent.sentiedge.ai \
  --build-arg VITE_COOKIE_DOMAIN=.sentiedge.ai \
  -t sentiedge-agent:v1 .
docker tag sentiedge-agent:v1 <target-account-id>.dkr.ecr.<region>.amazonaws.com/sentiedge-agent:v1
docker push <target-account-id>.dkr.ecr.<region>.amazonaws.com/sentiedge-agent:v1
```

### How to verify Step 6 is done

- [ ] All 3 Dockerfiles exist and build without errors
- [ ] All 3 images pushed to ECR
- [ ] Backend image starts and responds on port 8000
- [ ] Frontend image starts and responds on port 3000
- [ ] Agent image starts and responds on port 3000

---

## Step 7: Deploy All Three as ECS Services Behind ALB

> **Why:** This sets up the complete "green" environment in the new account. All three services run but receive no live traffic yet.

### 7.1 Create the ALB with host-based routing

```bash
# Single ALB for all three services
aws elbv2 create-load-balancer \
  --name sentiedge-alb \
  --subnets <public-subnet-a-id> <public-subnet-b-id> \
  --security-groups <sg-alb-id> \
  --scheme internet-facing --type application \
  --region <region> --profile <profile-target>
```

**Set ALB idle timeout to 600s** for the agent's SSE streaming:

```bash
aws elbv2 modify-load-balancer-attributes \
  --load-balancer-arn <alb-arn> \
  --attributes Key=idle_timeout.timeout_seconds,Value=600 \
  --region <region> --profile <profile-target>
```

### 7.2 Create three target groups

```bash
# Backend target group
aws elbv2 create-target-group \
  --name sentiedge-backend-tg --protocol HTTP --port 8000 \
  --vpc-id <vpc-id> --target-type ip \
  --health-check-path /api/health/ \
  --region <region> --profile <profile-target>

# Frontend target group
aws elbv2 create-target-group \
  --name sentiedge-frontend-tg --protocol HTTP --port 3000 \
  --vpc-id <vpc-id> --target-type ip \
  --health-check-path / \
  --region <region> --profile <profile-target>

# Agent target group
aws elbv2 create-target-group \
  --name sentiedge-agent-tg --protocol HTTP --port 3000 \
  --vpc-id <vpc-id> --target-type ip \
  --health-check-path /api/health \
  --health-check-timeout-seconds 30 \
  --region <region> --profile <profile-target>
```

### 7.3 Create HTTPS listener with host-based routing rules

```bash
# Default HTTPS listener (forwards to frontend by default)
aws elbv2 create-listener \
  --load-balancer-arn <alb-arn> \
  --protocol HTTPS --port 443 \
  --certificates CertificateArn=<acm-cert-sentiedge-ai> \
  --default-actions Type=forward,TargetGroupArn=<frontend-tg-arn> \
  --region <region> --profile <profile-target>

# Add additional ACM certs for other domains
aws elbv2 add-listener-certificates \
  --listener-arn <https-listener-arn> \
  --certificates CertificateArn=<acm-cert-api-sentiedge-ai> \
               CertificateArn=<acm-cert-agent-sentiedge-ai> \
  --region <region> --profile <profile-target>

# Rule: api.sentiedge.ai → backend
aws elbv2 create-rule \
  --listener-arn <https-listener-arn> \
  --conditions '[{"Field":"host-header","Values":["api.sentiedge.ai"]}]' \
  --actions '[{"Type":"forward","TargetGroupArn":"<backend-tg-arn>"}]' \
  --priority 10 \
  --region <region> --profile <profile-target>

# Rule: agent.sentiedge.ai → agent
aws elbv2 create-rule \
  --listener-arn <https-listener-arn> \
  --conditions '[{"Field":"host-header","Values":["agent.sentiedge.ai"]}]' \
  --actions '[{"Type":"forward","TargetGroupArn":"<agent-tg-arn>"}]' \
  --priority 20 \
  --region <region> --profile <profile-target>

# HTTP → HTTPS redirect
aws elbv2 create-listener \
  --load-balancer-arn <alb-arn> --protocol HTTP --port 80 \
  --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}' \
  --region <region> --profile <profile-target>
```

### 7.4 Create ECS cluster

```bash
aws ecs create-cluster --cluster-name sentiedge-cluster \
  --region <region> --profile <profile-target>
```

### 7.5 Register task definitions

Create three task definition files. Here's the key configuration for each:

**`task-def-backend.json`** — Django backend:

```json
{
  "family": "sentiedge-backend",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512", "memory": "1024",
  "executionRoleArn": "arn:aws:iam::<target-account-id>:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::<target-account-id>:role/ecsTaskRole-backend",
  "containerDefinitions": [{
    "name": "sentiedge-backend",
    "image": "<target-account-id>.dkr.ecr.<region>.amazonaws.com/sentiedge-backend:v1",
    "portMappings": [{ "containerPort": 8000 }],
    "environment": [
      { "name": "DJANGO_SETTINGS_MODULE", "value": "sentiedge_django_server.production_settings" },
      { "name": "DB_HOST", "value": "<rds-endpoint>" },
      { "name": "DB_PORT", "value": "3306" },
      { "name": "DB_NAME", "value": "sentiedge_072225" },
      { "name": "DB_USER", "value": "<db-user>" },
      { "name": "SMTP_HOST", "value": "smtp.gmail.com" },
      { "name": "SMTP_PORT", "value": "587" },
      { "name": "SMTP_USER", "value": "<smtp-user>" },
      { "name": "API_DOMAIN", "value": "api.sentiedge.ai" },
      { "name": "APP_SIGN_UP_URL", "value": "https://agent.sentiedge.ai/signup" }
    ],
    "secrets": [
      { "name": "DJANGO_SECRET_KEY", "valueFrom": "arn:aws:secretsmanager:<region>:<target-account-id>:secret:sentiedge/django-secret-key" },
      { "name": "DB_PASSWORD", "valueFrom": "arn:aws:secretsmanager:<region>:<target-account-id>:secret:sentiedge/db-password" },
      { "name": "SMTP_PASSWORD", "valueFrom": "arn:aws:secretsmanager:<region>:<target-account-id>:secret:sentiedge/smtp-password" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": { "awslogs-group": "/ecs/sentiedge-backend", "awslogs-region": "<region>", "awslogs-stream-prefix": "ecs" }
    },
    "essential": true
  }]
}
```

**`task-def-frontend.json`** — Next.js frontend:

```json
{
  "family": "sentiedge-frontend",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512", "memory": "1024",
  "executionRoleArn": "arn:aws:iam::<target-account-id>:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::<target-account-id>:role/ecsTaskRole-frontend",
  "containerDefinitions": [{
    "name": "sentiedge-frontend",
    "image": "<target-account-id>.dkr.ecr.<region>.amazonaws.com/sentiedge-frontend:v1",
    "portMappings": [{ "containerPort": 3000 }],
    "environment": [
      { "name": "NODE_ENV", "value": "production" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": { "awslogs-group": "/ecs/sentiedge-frontend", "awslogs-region": "<region>", "awslogs-stream-prefix": "ecs" }
    },
    "essential": true
  }]
}
```

**`task-def-agent.json`** — AI Agent:

```json
{
  "family": "sentiedge-agent",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024", "memory": "2048",
  "executionRoleArn": "arn:aws:iam::<target-account-id>:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::<target-account-id>:role/ecsTaskRole-agent",
  "containerDefinitions": [{
    "name": "sentiedge-agent",
    "image": "<target-account-id>.dkr.ecr.<region>.amazonaws.com/sentiedge-agent:v1",
    "portMappings": [{ "containerPort": 3000 }],
    "environment": [
      { "name": "NODE_ENV", "value": "production" },
      { "name": "SERVER_URL", "value": "https://agent.sentiedge.ai" },
      { "name": "SERVER_PORT", "value": "3000" },
      { "name": "CORS_ORIGIN", "value": "https://agent.sentiedge.ai,https://www.sentiedge.ai" },
      { "name": "SSE_KEEPALIVE_INTERVAL", "value": "15000" },
      { "name": "STREAM_TIMEOUT", "value": "600000" },
      { "name": "MONGODB_DATABASE", "value": "elizaAgent" },
      { "name": "RESEARCH_REPORT_BUCKET", "value": "sentiedge24-new" },
      { "name": "AWS_REGION", "value": "<region>" },
      { "name": "SMTP_HOST", "value": "smtp.gmail.com" },
      { "name": "SMTP_PORT", "value": "587" }
    ],
    "secrets": [
      { "name": "MONGODB_CONNECTION_STRING", "valueFrom": "arn:aws:secretsmanager:<region>:<target-account-id>:secret:sentiedge/docdb-connection-string" },
      { "name": "PRODUCTION_OPENAI_API_KEY", "valueFrom": "arn:aws:secretsmanager:<region>:<target-account-id>:secret:sentiedge/openai-api-key" },
      { "name": "PRODUCTION_COINMARKETCAP_API_KEY", "valueFrom": "arn:aws:secretsmanager:<region>:<target-account-id>:secret:sentiedge/coinmarketcap-api-key" },
      { "name": "PRODUCTION_NEWS_API_KEY", "valueFrom": "arn:aws:secretsmanager:<region>:<target-account-id>:secret:sentiedge/news-api-key" },
      { "name": "STRIPE_SECRET_KEY", "valueFrom": "arn:aws:secretsmanager:<region>:<target-account-id>:secret:sentiedge/stripe-secret-key" },
      { "name": "SMTP_PASSWORD", "valueFrom": "arn:aws:secretsmanager:<region>:<target-account-id>:secret:sentiedge/smtp-password" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": { "awslogs-group": "/ecs/sentiedge-agent", "awslogs-region": "<region>", "awslogs-stream-prefix": "ecs" }
    },
    "essential": true
  }]
}
```

Note: Agent gets more CPU/memory (1024/2048) because it runs LLM inference and embedding operations.

```bash
aws ecs register-task-definition --cli-input-json file://task-def-backend.json --region <region> --profile <profile-target>
aws ecs register-task-definition --cli-input-json file://task-def-frontend.json --region <region> --profile <profile-target>
aws ecs register-task-definition --cli-input-json file://task-def-agent.json --region <region> --profile <profile-target>
```

### 7.6 Create ECS services

```bash
# Backend service
aws ecs create-service \
  --cluster sentiedge-cluster --service-name sentiedge-backend \
  --task-definition sentiedge-backend --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<priv-sub-a>,<priv-sub-b>],securityGroups=[<sg-ecs-backend>],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=<backend-tg-arn>,containerName=sentiedge-backend,containerPort=8000" \
  --region <region> --profile <profile-target>

# Frontend service
aws ecs create-service \
  --cluster sentiedge-cluster --service-name sentiedge-frontend \
  --task-definition sentiedge-frontend --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<priv-sub-a>,<priv-sub-b>],securityGroups=[<sg-ecs-frontend>],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=<frontend-tg-arn>,containerName=sentiedge-frontend,containerPort=3000" \
  --region <region> --profile <profile-target>

# Agent service
aws ecs create-service \
  --cluster sentiedge-cluster --service-name sentiedge-agent \
  --task-definition sentiedge-agent --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<priv-sub-a>,<priv-sub-b>],securityGroups=[<sg-ecs-agent>],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=<agent-tg-arn>,containerName=sentiedge-agent,containerPort=3000" \
  --region <region> --profile <profile-target>
```

### 7.7 Verify all services are healthy

```bash
# Check all three services
for svc in sentiedge-backend sentiedge-frontend sentiedge-agent; do
  echo "=== $svc ==="
  aws ecs describe-services --cluster sentiedge-cluster --services $svc \
    --region <region> --profile <profile-target> \
    --query 'services[0].{status:status,running:runningCount,desired:desiredCount}'
done

# Check target group health
for tg in <backend-tg-arn> <frontend-tg-arn> <agent-tg-arn>; do
  echo "=== $tg ==="
  aws elbv2 describe-target-health --target-group-arn $tg \
    --region <region> --profile <profile-target>
done

# Hit health endpoints via ALB
curl -fsS -H "Host: api.sentiedge.ai" https://<alb-dns>/api/health/
curl -fsS -H "Host: www.sentiedge.ai" https://<alb-dns>/
curl -fsS -H "Host: agent.sentiedge.ai" https://<alb-dns>/api/health
```

### How to verify Step 7 is done

- [ ] ALB exists with host-based routing rules for all 3 domains
- [ ] All 3 ECS services running with `desired == running`
- [ ] All 3 target groups show healthy targets
- [ ] Health endpoints respond correctly when called with Host headers
- [ ] CloudWatch logs showing startup for all 3 services

### If something goes wrong

- **ECS tasks crashing**: Check CloudWatch logs. Common: missing env vars, DB connectivity, wrong security groups.
- **Health check failing**: Verify path matches exactly (`/api/health/` vs `/api/health`).
- **502/503 from ALB**: Security groups must allow ALB → ECS on correct port.
- **Agent SSE timeout**: ALB idle timeout must be 600s.
- **No live traffic impact**: DNS still points to old EC2s.

---

## Step 8: Set Up CI/CD Pipelines

> **Why:** Automated build/deploy pipelines replace the old CodeDeploy scripts for all three projects.

### 8.1 Backend pipeline (`.github/workflows/deploy-backend.yml`)

```yaml
name: Deploy Backend
on:
  push:
    branches: [main]
env:
  AWS_REGION: <region>
  ECR_REPO: sentiedge-backend
  ECS_CLUSTER: sentiedge-cluster
  ECS_SERVICE: sentiedge-backend
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<target-account-id>:role/cicd-deploy-role
          aws-region: ${{ env.AWS_REGION }}
      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2
      - run: |
          docker build -t ${{ steps.ecr.outputs.registry }}/$ECR_REPO:${{ github.sha }} .
          docker push ${{ steps.ecr.outputs.registry }}/$ECR_REPO:${{ github.sha }}
      - uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: task-def-backend.json
          service: ${{ env.ECS_SERVICE }}
          cluster: ${{ env.ECS_CLUSTER }}
          wait-for-service-stability: true
```

### 8.2 Frontend pipeline (`.github/workflows/deploy-frontend.yml`)

```yaml
name: Deploy Frontend
on:
  push:
    branches: [main]
env:
  AWS_REGION: <region>
  ECR_REPO: sentiedge-frontend
  ECS_CLUSTER: sentiedge-cluster
  ECS_SERVICE: sentiedge-frontend
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<target-account-id>:role/cicd-deploy-role
          aws-region: ${{ env.AWS_REGION }}
      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2
      - run: |
          docker build \
            --build-arg NEXT_PUBLIC_APP_URL=https://www.sentiedge.ai \
            --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.sentiedge.ai/api \
            -t ${{ steps.ecr.outputs.registry }}/$ECR_REPO:${{ github.sha }} .
          docker push ${{ steps.ecr.outputs.registry }}/$ECR_REPO:${{ github.sha }}
      - uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: task-def-frontend.json
          service: ${{ env.ECS_SERVICE }}
          cluster: ${{ env.ECS_CLUSTER }}
          wait-for-service-stability: true
```

### 8.3 Agent pipeline (`.github/workflows/deploy-agent.yml`)

```yaml
name: Deploy Agent
on:
  push:
    branches: [main]
env:
  AWS_REGION: <region>
  ECR_REPO: sentiedge-agent
  ECS_CLUSTER: sentiedge-cluster
  ECS_SERVICE: sentiedge-agent
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<target-account-id>:role/cicd-deploy-role
          aws-region: ${{ env.AWS_REGION }}
      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2
      - run: |
          docker build \
            --build-arg SERVER_BASE_URL=https://agent.sentiedge.ai \
            --build-arg VITE_APP_HOST_DOMAIN=https://agent.sentiedge.ai \
            --build-arg VITE_COOKIE_DOMAIN=.sentiedge.ai \
            -t ${{ steps.ecr.outputs.registry }}/$ECR_REPO:${{ github.sha }} .
          docker push ${{ steps.ecr.outputs.registry }}/$ECR_REPO:${{ github.sha }}
      - uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: task-def-agent.json
          service: ${{ env.ECS_SERVICE }}
          cluster: ${{ env.ECS_CLUSTER }}
          wait-for-service-stability: true
```

### How to verify Step 8 is done

- [ ] Each pipeline triggers on push to `main`
- [ ] Images build, push to ECR, and ECS services update
- [ ] All services reach steady state after deploy

---

## Step 9: End-to-End Testing of the Green Environment

> **Why:** Before switching live traffic, test everything against the ALB directly using Host headers.

### 9.1 Backend tests

```bash
# Health
curl -fsS -H "Host: api.sentiedge.ai" https://<alb-dns>/api/health/

# Login
curl -X POST -H "Host: api.sentiedge.ai" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"testpass"}' \
  https://<alb-dns>/api/authentication/validation/ -c cookies.txt -v

# Protected endpoint
curl -H "Host: api.sentiedge.ai" \
  https://<alb-dns>/api/some-protected-endpoint/ -b cookies.txt -v
```

### 9.2 Frontend tests

```bash
# Home page loads
curl -fsS -H "Host: www.sentiedge.ai" https://<alb-dns>/

# Check it references correct API URL in rendered HTML/JS
curl -s -H "Host: www.sentiedge.ai" https://<alb-dns>/ | grep "api.sentiedge.ai"
```

### 9.3 Agent tests

```bash
# Health
curl -fsS -H "Host: agent.sentiedge.ai" https://<alb-dns>/api/health

# List agents
curl -H "Host: agent.sentiedge.ai" https://<alb-dns>/agents

# Send a message (test SSE streaming)
curl -N -H "Host: agent.sentiedge.ai" \
  -H "Content-Type: application/json" \
  -d '{"text":"What is Bitcoin price?"}' \
  https://<alb-dns>/api/<agent-id>/message/stream
```

### 9.4 Cross-service tests

- [ ] Frontend login → calls backend API → gets JWT cookies → can access protected pages
- [ ] Frontend S3 data routes work (`/api/news/<symbol>`, `/api/sentiscore/<symbol>`)
- [ ] Agent writes to DocumentDB and reads back
- [ ] Agent's Stripe webhook endpoint reachable
- [ ] Email send works from both backend and agent
- [ ] CORS: frontend at `www.sentiedge.ai` can call `api.sentiedge.ai`

### How to verify Step 9 is done

- [ ] All three services respond correctly to Host-header requests
- [ ] Auth flow works end-to-end
- [ ] Database reads and writes work (both RDS and DocumentDB)
- [ ] SSE streaming works on the agent
- [ ] Email delivery works
- [ ] CORS passes for all frontend origins

### If something goes wrong

Fix issues in the green environment. Old EC2s still serve all live traffic.

---

## Step 10: Reduce DNS TTL (24 Hours Before Cutover)

> **Why:** Lower TTL means faster DNS propagation and faster rollback if needed.

### 10.1 In your third-party DNS provider

For ALL THREE records, lower TTL to 60s:

| Record | Current value | New TTL |
|--------|--------------|---------|
| `api.sentiedge.ai` | (old EC2 IP) | 60 |
| `www.sentiedge.ai` | (old EC2 IP) | 60 |
| `agent.sentiedge.ai` | (old EC2 IP) | 60 |

**Do NOT change the record values yet.**

### 10.2 Verify propagation

```bash
for domain in api.sentiedge.ai www.sentiedge.ai agent.sentiedge.ai; do
  echo "=== $domain ==="
  dig $domain @<dns-provider-ns> | grep TTL
done
```

### 10.3 Wait 24 hours before proceeding to Step 11

---

## Step 11: Execute DNS Cutover (Day 0)

> **Why:** This switches live traffic from old EC2s to the new ECS/ALB for all three services.

### 11.1 Pre-flight checks

```bash
# Verify AWS identity
aws sts get-caller-identity --profile <profile-target>

# Verify all 3 ECS services healthy
for svc in sentiedge-backend sentiedge-frontend sentiedge-agent; do
  aws ecs describe-services --cluster sentiedge-cluster --services $svc \
    --region <region> --profile <profile-target> \
    --query 'services[0].{running:runningCount,desired:desiredCount}'
done

# Verify all target groups healthy
for tg in <backend-tg> <frontend-tg> <agent-tg>; do
  aws elbv2 describe-target-health --target-group-arn $tg \
    --region <region> --profile <profile-target>
done

# Verify health endpoints
curl -fsS -H "Host: api.sentiedge.ai" https://<alb-dns>/api/health/
curl -fsS -H "Host: www.sentiedge.ai" https://<alb-dns>/
curl -fsS -H "Host: agent.sentiedge.ai" https://<alb-dns>/api/health
```

**STOP if any check fails.**

### 11.2 Record current DNS values (for rollback)

| Record | Type | Current Value | TTL |
|--------|------|---------------|-----|
| `api.sentiedge.ai` | | *(write it down)* | 60 |
| `www.sentiedge.ai` | | *(write it down)* | 60 |
| `agent.sentiedge.ai` | | *(write it down)* | 60 |

### 11.3 Switch all three DNS records

In your DNS provider, update all three records to point to the ALB:

| Record | New Value (CNAME to ALB) |
|--------|-------------------------|
| `api.sentiedge.ai` | `sentiedge-alb-xxxx.<region>.elb.amazonaws.com` |
| `www.sentiedge.ai` | `sentiedge-alb-xxxx.<region>.elb.amazonaws.com` |
| `agent.sentiedge.ai` | `sentiedge-alb-xxxx.<region>.elb.amazonaws.com` |

### 11.4 Verify DNS propagation

```bash
for domain in api.sentiedge.ai www.sentiedge.ai agent.sentiedge.ai; do
  echo "=== $domain ==="
  dig +short $domain @<dns-provider-ns>
done
```

All should resolve to the ALB DNS name.

### 11.5 Verify live endpoints

```bash
curl -fsS https://api.sentiedge.ai/api/health/
curl -fsS https://www.sentiedge.ai/
curl -fsS https://agent.sentiedge.ai/api/health
```

### 11.6 Monitor for 30+ minutes

Every 5 minutes:

```bash
# Health checks
curl -fsS https://api.sentiedge.ai/api/health/
curl -fsS https://www.sentiedge.ai/
curl -fsS https://agent.sentiedge.ai/api/health

# ALB 5xx errors
START=$(date -u -d '5 minutes ago' +%FT%TZ); END=$(date -u +%FT%TZ)
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value=<alb-dimension> \
  --start-time $START --end-time $END --period 60 --statistics Sum \
  --region <region> --profile <profile-target>
```

Also test:
- [ ] Login → JWT cookies → protected endpoint
- [ ] Agent message → SSE streaming response
- [ ] Email delivery from backend and agent
- [ ] Frontend pages load with data

### 11.7 Declare success or rollback

**Success:** All stable after 30 minutes → proceed to Step 12.

**Rollback:** If problems detected:
1. Revert all 3 DNS records to old values from Step 11.2
2. Verify: `dig +short <domain> @<dns-provider-ns>` returns old values
3. Verify: `curl -fsS https://<domain>/...` works on old EC2s
4. Investigate and reschedule

---

## Step 12: Post-Cutover Stabilization (Days +1 to +2)

> **Why:** Watch for edge cases and confirm everything works long-term.

### 12.1 Keep old EC2s running for 48 hours

Do NOT stop them. They are your safety net.

### 12.2 Monitor daily

- CloudWatch logs for all 3 services
- ALB 5xx metrics
- RDS MySQL: CPU, connections, storage
- DocumentDB: CPU, connections, cursors
- Email delivery

### 12.3 Stop DMS replication (if used for MySQL)

```bash
aws dms stop-replication-task --replication-task-arn <arn> \
  --region <region> --profile <profile-target>
```

### 12.4 Set source databases to read-only

```bash
# MySQL on source EC2
mysql -u root -p -e "SET GLOBAL read_only = 1;"

# SQLite on source EC2 (just stop the agent; SQLite is file-locked per process)
```

---

## Step 13: Rotate Credentials and Clean Up (Days +3 to +7)

> **Why:** Old secrets are exposed in git history and on old EC2s. Rotate everything.

### 13.1 Rotate Django SECRET_KEY

```bash
# Generate new key, update Secrets Manager, force ECS redeploy
aws secretsmanager update-secret --secret-id sentiedge/django-secret-key \
  --secret-string "<new-key>" --region <region> --profile <profile-target>
aws ecs update-service --cluster sentiedge-cluster --service sentiedge-backend \
  --force-new-deployment --region <region> --profile <profile-target>
```
**Note:** This invalidates user sessions. Users must re-login.

### 13.2 Rotate database passwords

```bash
# RDS MySQL
aws rds modify-db-instance --db-instance-identifier sentiedge-mysql \
  --master-user-password "<new-password>" --region <region> --profile <profile-target>
aws secretsmanager update-secret --secret-id sentiedge/db-password \
  --secret-string "<new-password>" --region <region> --profile <profile-target>
aws ecs update-service --cluster sentiedge-cluster --service sentiedge-backend \
  --force-new-deployment --region <region> --profile <profile-target>

# DocumentDB
aws docdb modify-db-cluster --db-cluster-identifier sentiedge-docdb \
  --master-user-password "<new-password>" --region <region> --profile <profile-target>
# Update MONGODB_CONNECTION_STRING in Secrets Manager with new password
aws secretsmanager update-secret --secret-id sentiedge/docdb-connection-string \
  --secret-string "<new-connection-string>" --region <region> --profile <profile-target>
aws ecs update-service --cluster sentiedge-cluster --service sentiedge-agent \
  --force-new-deployment --region <region> --profile <profile-target>
```

### 13.3 Rotate SMTP and API keys

- Gmail: Generate new app password, revoke old one
- OpenAI: Rotate API key in OpenAI dashboard
- Update all in Secrets Manager, force redeploy affected services

### 13.4 Snapshot and decommission old EC2s

```bash
# Snapshot each EC2
for instance in <backend-ec2> <frontend-ec2> <agent-ec2>; do
  aws ec2 create-image --instance-id $instance \
    --name "sentiedge-pre-decommission-$(date +%Y%m%d)" \
    --no-reboot --profile <profile-source>
done

# After sign-off, stop (then later terminate)
for instance in <backend-ec2> <frontend-ec2> <agent-ec2>; do
  aws ec2 stop-instances --instance-ids $instance --profile <profile-source>
done
```

### How to verify Step 13 is done

- [ ] All credentials rotated
- [ ] ECS services redeployed with new credentials
- [ ] Old EC2s snapshotted and stopped
- [ ] Old CodeDeploy applications cleaned up

---

## Quick Reference: Rollback at Any Point

| When | What to do |
|------|-----------|
| **Steps 1–10** | No live traffic impact. Fix or revert. |
| **Step 11 (cutover)** | Revert all 3 DNS records to old values. Old EC2s resume immediately. |
| **Step 12 (stabilization)** | Same — revert DNS. Old EC2s still running. |
| **After Step 13** | Harder — old credentials rotated. Would need to re-provision source. |

### Rollback triggers — act immediately:

- Sustained 5xx > 1% for 5+ minutes
- Authentication broken
- Data loss or inconsistency
- Agent SSE streaming broken
- Email delivery failing

### Rollback steps:

1. Revert all 3 DNS records in your provider
2. Verify: `dig +short <domain> @<dns-provider-ns>`
3. Verify: `curl -fsS https://<domain>/...`
4. Confirm write transaction works on source DBs
5. Post status to team

---

## Appendix A: Files Changed During Migration

| File | Project | What changes | Step |
|------|---------|-------------|------|
| `sentiedge_django_server/my_secret.py` | Backend | Remove hardcoded secrets | 1 |
| `sentiedge_django_server/production_settings.py` | Backend | Env-driven DB, domains, SECRET_KEY | 1 |
| `api/utils/email_utils.py` | Backend | Env-driven SMTP config | 1 |
| `Dockerfile` (new) | Backend | Container image | 6 |
| `task-def-backend.json` (new) | Backend | ECS task definition | 7 |
| `Dockerfile` (new) | Frontend | Multi-stage Next.js build | 6 |
| `task-def-frontend.json` (new) | Frontend | ECS task definition | 7 |
| `Dockerfile` (update) | Agent | Add DocumentDB TLS cert | 6 |
| `task-def-agent.json` (new) | Agent | ECS task definition | 7 |
| `.github/workflows/*.yml` (new) | All 3 | CI/CD pipelines | 8 |

## Appendix B: Architecture Decision Records

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Backend database | RDS MySQL | Django ORM, admin, migrations require relational DB. MongoDB adapters for Django are unreliable. |
| Agent database | Amazon DocumentDB (MongoDB) | Agent has built-in MongoDB support. Document-oriented data. Just set `MONGODB_CONNECTION_STRING`. |
| Vector embeddings | Store as Binary in DocumentDB, search in application code | Agent already handles this. DocumentDB doesn't support native vector search. |
| ALB strategy | Single ALB, host-based routing | Cost-efficient. One ALB serves all 3 domains with routing rules. |
| Frontend env vars | Build-time args (`--build-arg`) | `NEXT_PUBLIC_*` vars are baked into JS at build time by Next.js. |
| Agent ALB timeout | 600s idle timeout | SSE streaming requires long-lived connections (10 min analysis runs). |
| Agent CPU/memory | 1024/2048 (2x backend) | LLM inference and embedding operations are compute-intensive. |
| S3 access | Cross-account bucket policy initially, migrate buckets later | Faster to set up; clean up after stabilization. |
