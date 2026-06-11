# SentiEdge — Simplified AWS Migration Guide

## Overview

Migrate 3 projects from EC2 + CodeDeploy to ECS/Fargate + ALB + managed databases with near-zero downtime.

| Project | Stack | Current DB | Domain |
|---------|-------|-----------|--------|
| Django Backend | Django + Gunicorn (:8000) | MySQL (localhost) | `api.sentiedge.ai` |
| Next.js Frontend | Next.js 14 (:80) | None | `www.sentiedge.ai` |
| AI Agent | Node.js 23 + Express (:3000) | SQLite | `agent.sentiedge.ai` |

**Target:**
```
DNS → ALB (host-based routing) → 3 ECS Fargate services
                                  ├── Backend  → RDS MySQL
                                  ├── Frontend
                                  └── Agent    → DocumentDB (MongoDB)
```

---

## Step 1: Externalize Secrets (Code Changes)

Only the Django backend needs code changes. Frontend and Agent are already env-driven.

| File | Change |
|------|--------|
| `production_settings.py` | Read `SECRET_KEY`, `DB_*` from `os.environ` |
| `api/utils/email_utils.py` | Read `SMTP_*` from `os.environ` |
| `my_secret.py` | Stop importing, remove later |

**Verify:** `python manage.py check --deploy` with env vars set, no `my_secret.py` import.

---

## Step 2: Set Up AWS Infrastructure

Create all foundational resources in the new AWS account:

1. **VPC + Subnets** — 2 public (ALB) + 2 private (ECS + DBs) + IGW + NAT Gateway
2. **6 Security Groups:**
   - `sg-alb`: inbound 80/443 from anywhere
   - `sg-ecs-backend`: inbound 8000 from ALB
   - `sg-ecs-frontend`: inbound 3000 from ALB
   - `sg-ecs-agent`: inbound 3000 from ALB
   - `sg-rds`: inbound 3306 from backend SG
   - `sg-docdb`: inbound 27017 from agent SG
3. **3 ECR Repos** — `sentiedge-backend`, `sentiedge-frontend`, `sentiedge-agent`
4. **IAM Roles** — `ecsTaskExecutionRole` + per-service `ecsTaskRole`
5. **Secrets Manager** — store all secrets (Django key, DB passwords, API keys, SMTP)
6. **ACM Certificates** — request SSL for all 3 domains, validate via DNS CNAME
7. **S3 Access** — cross-account bucket policy or replicate buckets to new account

**Verify:** VPC/subnets exist, ECR repos accessible, ACM certs `ISSUED`.

---

## Step 3: Provision Managed Databases

| Database | Type | Purpose | Config |
|----------|------|---------|--------|
| RDS MySQL | `db.t3.medium`, Multi-AZ | Django backend data | Private subnets, `sg-rds` |
| DocumentDB | `db.t3.medium`, 2 instances | Agent data (replaces SQLite) | Private subnets, `sg-docdb`, TLS required |

**Key notes:**
- Download DocumentDB TLS cert: `global-bundle.pem`
- Agent already supports MongoDB — just set `MONGODB_CONNECTION_STRING`

**Verify:** Both databases status `available`, reachable from private subnets.

---

## Step 4: Migrate Data

### 4.1 MySQL → RDS

1. Export from source EC2: `mysqldump --single-transaction sentiedge_072225 > dump.sql`
2. Transfer to bastion host in new VPC
3. Import to RDS: `mysql -h <rds-endpoint> sentiedge_072225 < dump.sql`
4. Compare row counts for all tables

### 4.2 SQLite → DocumentDB

1. Export each table as JSON: `sqlite3 -json db.sqlite "SELECT * FROM <table>;"`
2. Convert embedding BLOBs to Binary format (Python script — see full plan Step 5.3)
3. Import via bastion: `mongoimport --host <docdb-endpoint> --tls --db elizaAgent --collection <name> --file <name>.json`
4. Create indexes (see full plan Step 5.5)
5. Compare document counts with source

**Verify:** Row/document counts match, spot-check data integrity.

---

## Step 5: Containerize and Push Images

### Dockerfile key points

| Project | Base Image | Notes |
|---------|-----------|-------|
| Backend | `python:3.10-slim` | Install MySQL client libs, run with `gunicorn` |
| Frontend | `node:20-slim` (multi-stage) | `NEXT_PUBLIC_*` vars injected via `--build-arg` at build time |
| Agent | Existing Dockerfile | Add `global-bundle.pem` TLS cert download |

### Push to ECR

```bash
aws ecr get-login-password | docker login --username AWS --password-stdin <ecr-url>
# For each project:
docker build -t sentiedge-<name>:v1 .
docker tag sentiedge-<name>:v1 <account>.dkr.ecr.<region>.amazonaws.com/sentiedge-<name>:v1
docker push <account>.dkr.ecr.<region>.amazonaws.com/sentiedge-<name>:v1
```

**Verify:** All 3 images build and start locally.

---

## Step 6: Deploy ECS Services + ALB

Set up the full "green" environment (no live traffic yet).

### In order:

1. **Create ALB** — public subnets, set idle timeout to **600s** (for Agent SSE streaming)
2. **Create 3 Target Groups** — backend:8000, frontend:3000, agent:3000
3. **Create HTTPS Listener** with host-based routing:
   - `api.sentiedge.ai` → backend TG
   - `www.sentiedge.ai` → frontend TG (default)
   - `agent.sentiedge.ai` → agent TG
   - HTTP :80 → redirect to HTTPS
4. **Create ECS Cluster**
5. **Register 3 Task Definitions** — env vars + Secrets Manager refs; Agent gets more resources (CPU 1024 / Memory 2048)
6. **Create 3 ECS Services** — Fargate, private subnets, linked to target groups

### Verify (using Host headers, DNS still points to old EC2s):

```bash
curl -H "Host: api.sentiedge.ai" https://<alb-dns>/api/health/
curl -H "Host: www.sentiedge.ai" https://<alb-dns>/
curl -H "Host: agent.sentiedge.ai" https://<alb-dns>/api/health
```

---

## Step 7: End-to-End Testing

Test everything against the ALB before switching DNS.

- [ ] All 3 health endpoints respond
- [ ] Login flow: frontend → backend API → JWT cookies
- [ ] Agent SSE streaming works
- [ ] Agent reads/writes DocumentDB
- [ ] Email delivery works
- [ ] CORS works (frontend → backend)
- [ ] S3 data access works

---

## Step 8: CI/CD Pipelines (Optional — can do after cutover)

One GitHub Actions workflow per project (`.github/workflows/deploy-*.yml`):
- Checkout → configure AWS credentials → ECR login → build & push → update ECS service

---

## Step 9: DNS Cutover (Go Live)

### 24 hours before:
- Lower TTL to 60s for all 3 domain records (keep values unchanged)

### Cutover day:

1. **Pre-flight check** — confirm all ECS services healthy, all target groups healthy
2. **Record old DNS values** (for rollback)
3. **Switch DNS** — CNAME all 3 domains to ALB DNS name
4. **Verify** — `dig` confirms resolution, `curl` confirms all endpoints
5. **Monitor 30 minutes** — health checks + CloudWatch 5xx metrics
6. **Decision:**
   - Stable → success, move to stabilization
   - Issues → **rollback immediately**: revert DNS to old values (60s TTL = fast recovery)

---

## Step 10: Post-Cutover (Days +1 to +7)

| When | Action |
|------|--------|
| +1–2 days | Keep old EC2s running as safety net, monitor new environment |
| +3 days | Set old databases to read-only |
| +3–7 days | Rotate all passwords and API keys (Secrets Manager + ECS redeploy) |
| +7 days | Snapshot old EC2s, then stop/terminate |

---

## Rollback Strategy

| Phase | How to rollback |
|-------|----------------|
| Steps 1–8 | No live traffic impact — fix freely |
| Step 9 (after DNS switch) | Revert DNS records to old EC2 IPs, effective in ~60s |
| Step 10 (after credential rotation) | Difficult — would need to reconfigure old environment |

### Rollback triggers (act immediately):
- Sustained 5xx errors > 5 minutes
- Auth/login broken
- Agent SSE streaming broken
- Data loss or inconsistency

---

## Appendix: 各步骤执行位置（本地 vs AWS）

### 本地（代码改动）

| 步骤 | 内容 | 说明 |
|------|------|------|
| Step 1 | 外部化密钥 | 改 Django 代码，把硬编码密钥改成 `os.environ` |
| Step 5 | 写 Dockerfile + 本地构建测试 | 在本地写好 Dockerfile，`docker build` 验证能跑 |
| Step 8 | CI/CD 流水线 | 在项目里写 `.github/workflows/deploy-*.yml` |

### AWS 控制台 / CLI

| 步骤 | 内容 | 说明 |
|------|------|------|
| Step 2 | 搭基础设施 | VPC、子网、安全组、ECR、IAM、Secrets Manager、ACM 证书 |
| Step 3 | 创建数据库 | RDS MySQL + DocumentDB |
| Step 6 | 部署 ECS + ALB | 创建 ALB、目标组、ECS 集群、任务定义、服务 |
| Step 9 | DNS 切换 | 改 DNS 记录指向 ALB（Route 53 或域名管理商） |

### 两边都涉及

| 步骤 | 本地做什么 | AWS 上做什么 |
|------|-----------|-------------|
| Step 4（数据迁移） | 从旧 EC2 导出 mysqldump、SQLite 导出 JSON | 通过跳板机导入到 RDS / DocumentDB |
| Step 5（推镜像） | 本地 `docker build` | `docker push` 到 ECR 仓库 |
| Step 7（端到端测试） | 本地用 `curl` 发请求测试 | 测的是 AWS 上的 ALB + ECS 服务 |
| Step 10（稳定期） | 监控、观察 | 旧 EC2 设只读、轮换密钥、最终关停 |

### 总结

```
本地电脑                          AWS
────────                        ────
Step 1: 改代码 ──push──→
                                Step 2: 建 VPC/子网/安全组/ECR/IAM
                                Step 3: 建 RDS + DocumentDB
Step 4: 导出数据 ──传输──→       Step 4: 导入数据
Step 5: docker build ──push──→  Step 5: ECR 存镜像
                                Step 6: 建 ALB + ECS 服务
Step 7: curl 测试 ──请求──→     Step 7: ALB + ECS 响应
Step 8: 写 CI/CD 配置 ──push──→
                                Step 9: DNS 切换
                                Step 10: 清理旧环境
```

核心思路：本地负责"代码和镜像"，AWS 负责"基础设施和运行环境"，中间通过 ECR（镜像仓库）和 Git（代码仓库）连接。

---

## Appendix: Where Each Step Is Executed (Local vs AWS)

### Local (Code Changes)

| Step | What | Details |
|------|------|---------|
| Step 1 | Externalize secrets | Modify Django code to read secrets from `os.environ` |
| Step 5 | Write Dockerfiles + local build | Write Dockerfiles locally, verify with `docker build` |
| Step 8 | CI/CD pipelines | Write `.github/workflows/deploy-*.yml` in the repo |

### AWS Console / CLI

| Step | What | Details |
|------|------|---------|
| Step 2 | Set up infrastructure | VPC, subnets, security groups, ECR, IAM, Secrets Manager, ACM certs |
| Step 3 | Create databases | RDS MySQL + DocumentDB |
| Step 6 | Deploy ECS + ALB | Create ALB, target groups, ECS cluster, task definitions, services |
| Step 9 | DNS cutover | Point DNS records to ALB (Route 53 or domain registrar) |

### Both Local and AWS

| Step | Local | AWS |
|------|-------|-----|
| Step 4 (Data migration) | Export mysqldump from old EC2, export SQLite to JSON | Import to RDS / DocumentDB via bastion host |
| Step 5 (Push images) | `docker build` locally | `docker push` to ECR |
| Step 7 (E2E testing) | Run `curl` requests locally | ALB + ECS services respond |
| Step 10 (Stabilization) | Monitor and observe | Set old DBs read-only, rotate credentials, decommission EC2s |

### Summary

```
Local Machine                       AWS
─────────────                       ───
Step 1: Code changes ──push──→
                                    Step 2: Create VPC/Subnets/SGs/ECR/IAM
                                    Step 3: Create RDS + DocumentDB
Step 4: Export data ──transfer──→   Step 4: Import data
Step 5: docker build ──push──→      Step 5: ECR stores images
                                    Step 6: Create ALB + ECS services
Step 7: curl tests ──request──→     Step 7: ALB + ECS respond
Step 8: Write CI/CD configs ──push──→
                                    Step 9: DNS cutover
                                    Step 10: Decommission old environment
```

Local handles "code and images", AWS handles "infrastructure and runtime". They connect through ECR (image registry) and Git (code repository).