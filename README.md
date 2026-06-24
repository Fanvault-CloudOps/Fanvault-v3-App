# FanVault v3 — Fan Merchandise E-Commerce Platform

FanVault is a production-grade e-commerce platform for fan merchandise (sports, entertainment, franchise collectibles). v3 migrated from MongoDB to **AWS DynamoDB** and added a full event-driven pipeline — EventBridge, Lambda consumers, SNS/SQS alerting — all fronted by CloudFront with WAFv2.

- **Runtime:** Node.js ≥ 18 (backend), React 18 / Vite 6 (frontend)
- **Database:** AWS DynamoDB (6 tables, PAY_PER_REQUEST, PITR, KMS)
- **Region:** `us-east-1`
- **Deployment:** EC2 Auto Scaling Groups, managed by Terraform CI/CD

---

## Repository Structure

```
Fanvault-v3-App/
├── fanvault-user-service/        # Identity Service  — Express  :3001  (Node.js)
├── fanvault-commerce-service/    # Commerce Service  — Express  :3002  (Node.js)
├── fanvault-ai-service/          # AI Metadata Svc   — FastAPI  :8000  (Python)
├── fanvault-frontend/            # React SPA         — Nginx    :80
├── shared-resources/
│   ├── database/
│   │   ├── seed-data.js          # MongoDB seed (v2 legacy)
│   │   └── seed-dynamodb.js      # DynamoDB seed script
│   ├── migrate-to-dynamodb.js    # One-time v2 → v3 migration helper
│   ├── healthcheck/healthcheck.sh
│   └── nginx/alb-listener.conf
└── deploy/
    ├── aws-userdata-app.sh       # EC2 user data — full stack bootstrap
    └── aws-userdata-db.sh        # EC2 user data — legacy MongoDB setup
```

Each service has its own `README.md` with full API reference, data model, environment variables, and deployment notes.

---

## Application Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         FanVault v3 — Application Architecture               │
└──────────────────────────────────────────────────────────────────────────────┘

  Browser / Admin Client
         │
         │  HTTPS  (all paths)
         ▼
  ┌──────────────────┐
  │   CloudFront     │◄─── WAFv2 (rate limit, common rules, IP reputation,
  │   Distribution   │           geo-block optional)
  └────────┬─────────┘
           │
     ┌─────┴──────────────────────────────┐
     │   Path routing (CloudFront)        │
     │                                    │
     │  /products/*  /thumbnails/*        │
     │  /categories/*  /images/*    ──────┼──► S3 Product Images (OAC)
     │                                    │
     │  Everything else              ─────┼──► ALB  (X-Custom-Header injected)
     └────────────────────────────────────┘
                                          │
                   ┌──────────────────────▼──────────────────────────┐
                   │              Application Load Balancer           │
                   │  Default: 403 (blocks requests without header)   │
                   │                                                  │
                   │  P5   arch.fanvault.com        → Lambda          │
                   │  P10  /api/auth*               → Identity :3001  │
                   │  P15  /api/admin*              → Commerce :3002  │
                   │  P20  /api/users*              → Identity :3001  │
                   │  P30  /api/products*           → Commerce :3002  │
                   │  P40  /api/orders*             → Commerce :3002  │
                   │  P99  /*                       → Frontend  :80   │
                   └──────────┬──────────────────────────────────────┘
                              │
              ┌───────────────┼─────────────────────┐
              │               │                     │
              ▼               ▼                     ▼
  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────┐
  │  Frontend ASG   │  │   Backend ASG    │  │ Lambda        │
  │                 │  │  (monolithic)    │  │ arch-page     │
  │  Nginx :80      │  │                 │  │ (Node.js 20x) │
  │  React 18 SPA   │  │  fanvault-auth  │  └───────┬───────┘
  │  (static files) │  │  systemd :3001  │          │
  │                 │  │                 │          ▼
  │  Private        │  │  fanvault-comm  │   S3 Arch Bucket
  │  frontend       │  │  systemd :3002  │
  │  subnets        │  │                 │
  │  10.0.11-12/24  │  │  Private backend│
  └─────────────────┘  │  subnets        │
                       │  10.0.21-22/24  │
                       └────────┬────────┘
                                │
              ┌─────────────────┼──────────────────────┐
              │                 │                      │
              ▼                 ▼                      ▼
  ┌───────────────────┐  ┌──────────────┐  ┌──────────────────────┐
  │ DynamoDB          │  │ SSM Param    │  │ EventBridge          │
  │ (VPC Gateway      │  │ Store        │  │ fanvault-event-bus   │
  │  Endpoint)        │  │ /fanvault/*  │  │ source:              │
  │                   │  │             │  │ fanvault.commerce    │
  │ fanvault-users    │  │ 19 params    │  └──────────┬───────────┘
  │ fanvault-profiles │  │ (config +   │             │
  │ fanvault-products │  │  secrets)   │  ┌──────────┼──────────────┐
  │ fanvault-orders   │  └─────────────┘  │          │              │
  │ fanvault-audit-   │                   ▼          ▼              ▼
  │   logs (1d TTL)   │           ┌────────────┐┌──────────┐┌──────────────┐
  │ fanvault-metadata │           │ Audit Log  ││Thumbnail ││ Inventory    │
  └───────────────────┘           │ Lambda     ││Generator ││ Monitor      │
                                  └─────┬──────┘└────┬─────┘└──────┬───────┘
                                        │            │             │
                                        └────────────┼─────────────┘
                                                     ▼
                                        ┌────────────────────────────┐
                                        │ SNS Topics (KMS-encrypted) │
                                        │ + SQS queues (fan-out)     │
                                        │ + Email (optional)         │
                                        └────────────────────────────┘
```

---

## AWS Cloud Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  AWS Account  us-east-1                                                         │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │  CloudFront  +  WAFv2 Web ACL  (global edge)                              │  │
│  │  ┌─────────────────────────┐   ┌──────────────────────────────────────┐   │  │
│  │  │ Origin 1: ALB           │   │ WAF Rules (priority order):          │   │  │
│  │  │  X-Custom-Header injected│   │  10 AWSManagedRulesCommonRuleSet     │   │  │
│  │  │  http-only to ALB :80   │   │  20 AWSManagedRulesKnownBadInputs   │   │  │
│  │  └─────────────────────────┘   │  30 AWSManagedRulesAmazonIpRepList  │   │  │
│  │  ┌─────────────────────────┐   │  40 RateLimit: 100 req/5min per IP  │   │  │
│  │  │ Origin 2: S3 (OAC)      │   │  50 GeoBlock (if configured)        │   │  │
│  │  │  /products/* /thumbs/*  │   └──────────────────────────────────────┘   │  │
│  │  │  /categories/* /images/*│                                              │  │
│  │  └─────────────────────────┘                                              │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                          │                         │                            │
│                          ▼                         ▼                            │
│  ┌───────────────────────────────────┐   ┌────────────────────────────────┐    │
│  │  VPC  10.0.0.0/16                 │   │  S3 Buckets (private)          │    │
│  │                                   │   │  fanvault-product-images-*     │    │
│  │  ┌─── Public Subnets ──────────┐  │   │    versioned, lifecycle rules  │    │
│  │  │  10.0.1.0/24  us-east-1a   │  │   │    OAC → CloudFront only       │    │
│  │  │  10.0.2.0/24  us-east-1b   │  │   │                                │    │
│  │  │                             │  │   │  fanvault-architecture-*       │    │
│  │  │  ┌─────────┐  ┌─────────┐  │  │   │    Lambda reads arch.png        │    │
│  │  │  │   ALB   │  │ Bastion │  │  │   └────────────────────────────────┘    │
│  │  │  │(internet│  │t3.micro │  │  │                                         │
│  │  │  │ facing) │  │IMDSv2   │  │  │   ┌────────────────────────────────┐    │
│  │  │  └────┬────┘  └────┬────┘  │  │   │  DynamoDB Tables               │    │
│  │  │       │       NAT GW│  EIP  │  │   │  (VPC Gateway Endpoint)        │    │
│  │  └───────┼────────────┼───────┘  │   │                                │    │
│  │          │            │          │   │  fanvault-users                │    │
│  │  ┌── Frontend Priv ───┼───────┐  │   │    PK:userId  GSI:email-index  │    │
│  │  │  10.0.11.0/24  1a  │       │  │   │  fanvault-profiles             │    │
│  │  │  10.0.12.0/24  1b  │       │  │   │    PK:userId                   │    │
│  │  │                    │       │  │   │  fanvault-products             │    │
│  │  │  ┌─────────────────┐  ASG  │  │   │    PK:productId  2 GSIs        │    │
│  │  │  │ Nginx  :80      │  1-4  │  │   │  fanvault-orders               │    │
│  │  │  │ React SPA       │  inst.│  │   │    PK:orderId  3 GSIs          │    │
│  │  │  │ t3.small        │       │  │   │  fanvault-audit-logs           │    │
│  │  │  │ Ubuntu 22.04    │       │  │   │    PK:logId  TTL:1 day         │    │
│  │  │  └─────────────────┘       │  │   │  fanvault-metadata             │    │
│  │  └────────────────────────────┘  │   │    PK:metaType  SK:metaId      │    │
│  │                                   │   └────────────────────────────────┘    │
│  │  ┌── Backend Priv ─────────────┐  │                                         │
│  │  │  10.0.21.0/24  1a           │  │   ┌────────────────────────────────┐    │
│  │  │  10.0.22.0/24  1b           │  │   │  EventBridge + Lambda          │    │
│  │  │                             │  │   │                                │    │
│  │  │  ┌─────────────────┐  ASG  │  │   │  fanvault-event-bus            │    │
│  │  │  │ Identity  :3001 │  1-4  │  │   │  ├─ audit-logging-consumer     │    │
│  │  │  │ Commerce  :3002 │  inst.│  │   │  ├─ thumbnail-generator        │    │
│  │  │  │ t3.small  (both)│       │  │   │  └─ inventory-monitor          │    │
│  │  │  │ Ubuntu 22.04    │       │  │   │                                │    │
│  │  │  │ systemd PM      │       │  │   │  SQS DLQ (14-day retention)    │    │
│  │  │  └─────────────────┘       │  │   └────────────────────────────────┘    │
│  │  └────────────────────────────┘  │                                         │
│  │                                   │   ┌────────────────────────────────┐    │
│  │  ┌── DB Priv Subnets ──────────┐  │   │  SNS + SQS (KMS-encrypted)    │    │
│  │  │  10.0.31.0/24  1a           │  │   │                                │    │
│  │  │  10.0.32.0/24  1b           │  │   │  low-inventory-alerts          │    │
│  │  │  (VPC Endpoints only)       │  │   │  order-failure-alerts          │    │
│  │  └────────────────────────────┘  │   │  product-upload-failures       │    │
│  │                                   │   │  admin-operational-alerts      │    │
│  │  VPC Interface Endpoints:         │   └────────────────────────────────┘    │
│  │  SSM, SSMMessages, EC2Messages,   │                                         │
│  │  SecretsManager → backend subnets │   ┌────────────────────────────────┐    │
│  │  S3, DynamoDB Gateway → all priv  │   │  SSM Parameter Store           │    │
│  └───────────────────────────────────┘   │  19 params under /fanvault/*   │    │
│                                           │  (git, app, dynamodb, s3, sns) │    │
│  ┌─────────────────────────────────────┐  └────────────────────────────────┘    │
│  │  IAM Roles                          │                                        │
│  │  ec2-backend  → DynamoDB+SSM+S3+EB  │  ┌────────────────────────────────┐   │
│  │  ec2-frontend → SSM(git)+CW         │  │  CloudWatch                    │   │
│  │  lambda-s3    → S3 ReadOnly         │  │  Alarms: ALB, ASG, DDB,        │   │
│  │  lambda-cons  → DDB+S3+SNS          │  │  Lambda, SNS (→ admin SNS)     │   │
│  │  github-oidc  → AdministratorAccess │  │  Dashboard: observability      │   │
│  └─────────────────────────────────────┘  └────────────────────────────────┘   │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  Terraform Remote State                                                  │   │
│  │  S3: fanvault-v2-tfstate-899071933396   DynamoDB lock: fanvault-v2-tfstate-locks │
│  └─────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Event-Driven Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  FanVault Event-Driven Architecture                                             │
└─────────────────────────────────────────────────────────────────────────────────┘

  Commerce Service (EC2 :3002)
  │
  │  publishEvent(detailType, payload)          [fire-and-forget — never blocks HTTP]
  │  Source: "fanvault.commerce"
  │
  │  Triggers:
  │  ├─ ProductCreated   → on POST /api/products
  │  ├─ ProductUpdated   → on PATCH /api/products/:id
  │  ├─ InventoryLow     → when stock ≤ 5 (create or update)
  │  └─ OrderPlaced      → on POST /api/orders
  │
  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  EventBridge Custom Bus: fanvault-event-bus                                 │
└──────────────────────────────────────────────────────────────────────────────┘
         │
         │  Rule matching: source = "fanvault.commerce"
         │
         ├─────────────────────────────────────────────────────────┐
         │  Rule 1: All events                                      │
         │  Pattern: { source: ["fanvault.commerce"] }             │
         ▼                                                          │
  ┌─────────────────────────────────────────────┐                  │
  │  Lambda: fanvault-audit-logging-consumer    │                  │
  │  Node.js 20.x  Timeout: 15s                 │                  │
  │                                             │                  │
  │  ┌─────────────────────────────────────┐    │                  │
  │  │  Writes to DynamoDB audit-logs:      │    │                  │
  │  │  logId (UUID), adminId, adminEmail  │    │                  │
  │  │  action, entityType, entityId       │    │                  │
  │  │  changes (JSON), timestamp          │    │                  │
  │  │  ttlExpiry (+86400s = 1 day TTL)    │    │                  │
  │  └─────────────────────────────────────┘    │                  │
  └─────────────────────────────────────────────┘                  │
                                                                   │
         │  Rule 2: ProductCreated / ProductUpdated                │
         │  Pattern: { detail-type: ["ProductCreated",             │
         │             "ProductUpdated"] }                          │
         ▼                                                          │
  ┌─────────────────────────────────────────────┐                  │
  │  Lambda: fanvault-thumbnail-generator       │                  │
  │  Node.js 20.x  Timeout: 30s                 │                  │
  │                                             │                  │
  │  ┌─────────────────────────────────────┐    │                  │
  │  │  For each image in products/:       │    │                  │
  │  │  1. S3 GetObject (products/*)       │    │                  │
  │  │  2. S3 PutObject → thumbnails/*     │    │                  │
  │  │  3. DynamoDB UpdateItem — set       │    │                  │
  │  │     product.thumbnails[]            │    │                  │
  │  │  On error → SNS product-upload-     │    │                  │
  │  │  failures topic                     │    │                  │
  │  └─────────────────────────────────────┘    │                  │
  └─────────────────────────────────────────────┘                  │
                                                                   │
         │  Rule 3: InventoryLow                                    │
         │  Pattern: { detail-type: ["InventoryLow"] }              │
         ▼                                                          │
  ┌─────────────────────────────────────────────┐                  │
  │  Lambda: fanvault-inventory-monitor         │                  │
  │  Node.js 20.x  Timeout: 15s                 │                  │
  │                                             │                  │
  │  ┌─────────────────────────────────────┐    │                  │
  │  │  Formats structured alert:          │    │                  │
  │  │  ⚠️ [WARNING] LowInventoryAlert     │    │                  │
  │  │  productId, productName, sku, stock │    │                  │
  │  │  → SNS: low-inventory-alerts        │    │                  │
  │  └─────────────────────────────────────┘    │                  │
  └─────────────────────────────────────────────┘                  │
                                                                   │
         │  Rule 4: InventoryLow (direct to SNS)                   │
         │  EventBridge → SNS low-inventory-alerts directly        │
         ▼                                                         │
                                                                   │
  ┌──────────────────────────────────────────────────────────────┐ │
  │  SNS Topics (KMS-encrypted, alias/fanvault-sns-key)          │ │
  │                                                              │ │
  │  ┌──────────────────────────────────────────────────────┐    │ │
  │  │ fanvault-low-inventory-alerts                        │◄───┘ │
  │  │ fanvault-order-failure-alerts                        │      │
  │  │ fanvault-product-upload-failures                     │      │
  │  │ fanvault-admin-operational-alerts   ◄── CW Alarms   │      │
  │  └────────────────────┬─────────────────────────────────┘      │
  │                       │  SQS Subscriptions (redrive → sns-dlq) │
  │                       ▼                                         │
  │  ┌────────────────────────────────────────────────────────┐     │
  │  │  SQS Queues (KMS-encrypted, 14-day retention)          │     │
  │  │  fanvault-low-inventory-alerts-queue                   │     │
  │  │  fanvault-order-failure-alerts-queue                   │     │
  │  │  fanvault-product-upload-failures-queue                │     │
  │  │  fanvault-admin-operational-alerts-queue               │     │
  │  └────────────────────────────────────────────────────────┘     │
  │                       + optional email subscriptions             │
  └──────────────────────────────────────────────────────────────────┘

  Retry + DLQ Strategy:
  ┌────────────────────────────────────────────────────────────┐
  │  All EventBridge rules:                                    │
  │    retry_policy: max 3 attempts over 1 hour                │
  │    dead_letter: → fanvault-event-dlq (SQS, 14-day)        │
  │                                                            │
  │  SNS subscriptions:                                        │
  │    redrive_policy: → fanvault-sns-dlq (SQS, 14-day, KMS)  │
  └────────────────────────────────────────────────────────────┘

  Direct App → SNS (bypassing EventBridge):
  ┌────────────────────────────────────────────────────────────┐
  │  Commerce Service → snsPublisher.publishAlert()            │
  │  Used for order failures and critical operational events   │
  │  that need immediate notification without event routing    │
  └────────────────────────────────────────────────────────────┘
```

---

## Services

| Service | Port | Language | Description |
|---|---|---|---|
| `fanvault-user-service` | `3001` | Node.js 18+ | Cognito auth, user profile management, shipping addresses |
| `fanvault-commerce-service` | `3002` | Node.js 18+ | Product catalog, orders, admin, S3 image uploads, EventBridge events |
| `fanvault-ai-service` | `8000` | Python 3.12 / FastAPI | Bedrock AI metadata generation from product images |
| `fanvault-frontend` | `80` | React 18 / Nginx | SPA — shop, cart, checkout, admin portal |

See each service's own README for full API reference, data model, and environment variables:
- [fanvault-user-service/README.md](fanvault-user-service/README.md)
- [fanvault-commerce-service/README.md](fanvault-commerce-service/README.md)
- [fanvault-ai-service/README.md](fanvault-ai-service/README.md)
- [fanvault-frontend/README.md](fanvault-frontend/README.md)

---

## DynamoDB Data Model

All tables: **PAY_PER_REQUEST**, **KMS server-side encryption**, **PITR enabled**.

```
fanvault-users
  PK: userId (UUID)
  Attrs: email, passwordHash, role (user|admin), isActive, createdAt, updatedAt
  GSI: email-index (PK: email) — login/registration checks

fanvault-profiles
  PK: userId (matches users PK — 1:1)
  Attrs: displayName, phone, addresses[], preferences, createdAt, updatedAt

fanvault-products
  PK: productId (UUID)
  Attrs: name, description, price, comparePrice, category, franchise,
         franchiseType, sku, stock, images[], thumbnails[], isActive,
         createdAt, updatedAt
  GSI: sku-index (PK: sku) — unique SKU lookup
  GSI: category-franchise-index (PK: category, SK: franchise) — filtered listing

fanvault-orders
  PK: orderId (UUID)
  Attrs: orderNumber (FAN-XXXX), userId, userEmail, items[],
         shippingAddress, subtotal, shippingCost (₹99, free ≥₹1999),
         tax (18% GST), total, paymentMethod, status, notes,
         createdAt, updatedAt
  GSI: userId-createdAt-index (PK: userId, SK: createdAt) — user order history
  GSI: orderNumber-index (PK: orderNumber) — customer support lookup
  GSI: status-createdAt-index (PK: status, SK: createdAt) — admin order dashboard

fanvault-audit-logs
  PK: logId (UUID)
  Attrs: adminId, adminEmail, action (PRODUCT_CREATED|UPDATED|DELETED|
         STOCK_UPDATED|IMAGE_UPLOAD_URL_GENERATED|CATEGORY_UPSERTED...),
         entityType, entityId, changes (JSON), timestamp, ttlExpiry
  TTL: ttlExpiry (Unix epoch, items expire after 1 day)
  GSI: entityType-timestamp-index
  GSI: adminId-timestamp-index

fanvault-metadata
  PK: metaType (category|franchise)
  SK: metaId (slug, e.g. "clothing", "mumbai-indians")
  Attrs: displayName, isActive, createdAt, updatedAt
```

---

## Image Upload Flow

```
Admin Browser                  Commerce Service              S3 Bucket
     │                              │                            │
     │  GET /api/products/upload-url│                            │
     │  ?fileType=image/png         │                            │
     │  &fileSize=204800            │                            │
     │  &folder=products            │                            │
     ├─────────────────────────────►│                            │
     │                              │  Fetch S3 config from SSM  │
     │                              │  Validate: type, size, folder│
     │                              │  Generate S3 key:          │
     │                              │  products/{uuid}.png       │
     │                              │  Generate presigned PUT URL│
     │  { uploadUrl, key }          │  (15 min expiry)           │
     │◄─────────────────────────────│                            │
     │                              │                            │
     │  PUT uploadUrl               │                            │
     │  Content-Type: image/png     │                            │
     │  [binary image data]         │                            │
     ├──────────────────────────────┼───────────────────────────►│
     │  200 OK (ETag)               │                            │
     │◄─────────────────────────────┼───────────────────────────-│
     │                              │                            │
     │  POST /api/products          │                            │
     │  { ..., images: ["products/  │                            │
     │         {uuid}.png"] }       │                            │
     ├─────────────────────────────►│                            │
     │                              │  Create product in DynamoDB│
     │                              │  Publish ProductCreated    │
     │                              │    → EventBridge           │
     │  201 Created                 │                            │
     │◄─────────────────────────────│                            │

Images are served via CloudFront: https://{cf-domain}/products/{uuid}.png
Thumbnails auto-generated by Lambda consumer → thumbnails/{uuid}.png
```

---

## Deployment

Infrastructure is managed by the [Terraform-Fanvault-Infra](../Terraform-Fanvault-Infra/) repo. EC2 instances are bootstrapped by `deploy/aws-userdata-app.sh` via Launch Template user data.

### Local Development

```bash
# 1. User Service
cd fanvault-user-service
cp .env.example .env   # fill in Cognito pool/client IDs and DynamoDB table name
npm install && npm run dev      # nodemon on :3001

# 2. Commerce Service (new terminal)
cd fanvault-commerce-service
cp .env.example .env   # fill in DynamoDB table names, Cognito IDs, S3/SNS/EventBridge config
npm install && npm run dev      # nodemon on :3002

# 3. AI Service (new terminal)
cd fanvault-ai-service
pip install -r requirements.txt
AWS_REGION=us-east-1 BEDROCK_MODEL_ID=amazon.nova-pro-v1:0 uvicorn main:app --port 8000

# 4. Frontend (new terminal)
cd fanvault-frontend
npm install && npm run dev      # Vite on :5173
```

### Seed DynamoDB

```bash
cd shared-resources/database
npm install
AWS_REGION=us-east-1 node seed-dynamodb.js
```

### Health Checks

```bash
curl http://localhost:3001/health
# → {"status":"ok","service":"fanvault-user-service","database":"dynamodb","timestamp":"..."}

curl http://localhost:3002/health
# → {"status":"ok","service":"fanvault-commerce-service","database":"dynamodb","timestamp":"..."}

curl http://localhost:8000/health
# → {"status":"ok","service":"fanvault-ai-service"}

curl http://localhost:8000/health/bedrock
# → {"status":"ok","model_id":"amazon.nova-pro-v1:0","region":"us-east-1","iam_arn":"..."}
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite 6, React Router v6, Axios, react-hot-toast, lucide-react |
| Backend | Node.js ≥ 18, Express 4, Helmet, Morgan, express-rate-limit, express-validator |
| Auth | AWS Cognito (InitiateAuthCommand), JWT decode (jsonwebtoken) |
| Database | AWS DynamoDB (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`) |
| Storage | AWS S3 + Presigner (`@aws-sdk/s3-request-presigner`) |
| CDN | AWS CloudFront + OAC |
| Events | AWS EventBridge (custom bus) |
| Alerts | AWS SNS (KMS-encrypted) + SQS fan-out |
| Config | AWS SSM Parameter Store |
| Secrets | AWS Secrets Manager (optional, production) |
| Web Server | Nginx (static files + local API proxy) |
| Process Mgmt | systemd (fanvault-auth, fanvault-commerce) |
| AI | AWS Bedrock (`amazon.nova-pro-v1:0`), boto3, FastAPI |
| Infrastructure | Terraform ≥ 1.5, AWS Provider ~5.0 |
| CI/CD | GitHub Actions + OIDC |
| Kubernetes | Helm 3, ArgoCD (see [Fanvault-GitOps](../Fanvault-GitOps/)) |
