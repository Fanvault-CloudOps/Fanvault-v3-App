# FanVault v3 — Fan Merchandise E-Commerce Platform

FanVault is a production-grade e-commerce platform for fan merchandise (sports, entertainment, franchise collectibles). v3 migrated the database from MongoDB to **AWS DynamoDB** and integrated a full event-driven pipeline with EventBridge, Lambda consumers, and SNS alerting, all exposed through CloudFront with WAFv2 protection.

---

## Repository Structure

```
Fanvault-v3-App/
├── fanvault-user-auth-service/     # Identity Service — Node.js/Express (port 3001)
│   ├── src/
│   │   ├── config/db.js            # DynamoDB client init + optional Secrets Manager
│   │   ├── controllers/            # auth.controller.js, user.controller.js
│   │   ├── middleware/auth.middleware.js
│   │   ├── models/                 # User.js, UserProfile.js (DynamoDB repos)
│   │   └── routes/                 # auth.routes.js, user.routes.js
│   ├── deploy/
│   │   ├── fanvault-auth.service   # systemd unit file
│   │   └── deploy.sh
│   ├── .env.example
│   └── package.json
│
├── fanvault-commerce-service/      # Commerce Service — Node.js/Express (port 3002)
│   ├── src/
│   │   ├── config/db.js            # DynamoDB client init + optional Secrets Manager
│   │   ├── controllers/            # product.controller.js, order.controller.js, admin.controller.js
│   │   ├── middleware/auth.middleware.js
│   │   ├── models/                 # Product.js, Order.js, AuditLog.js, Metadata.js
│   │   ├── routes/                 # product.routes.js, order.routes.js, admin.routes.js
│   │   └── utils/
│   │       ├── eventPublisher.js   # EventBridge PutEvents
│   │       ├── snsPublisher.js     # Structured SNS alert publisher
│   │       └── auditLogger.js      # Fire-and-forget audit log writer (DynamoDB)
│   ├── deploy/
│   │   ├── fanvault-commerce.service
│   │   └── deploy.sh
│   ├── .env.example
│   └── package.json
│
├── fanvault-frontend/              # React 18 SPA — Vite build, served by Nginx
│   ├── src/
│   │   ├── App.jsx                 # Routing (public + protected + admin portal)
│   │   ├── api/client.js           # Axios instance with auth interceptors
│   │   ├── context/                # AuthContext.jsx, CartContext.jsx
│   │   ├── components/             # Navbar, Footer, ProductCard, ErrorBoundary
│   │   └── pages/                  # HomePage, Products, Cart, Checkout, Orders, Profile
│   │       └── admin/              # AdminDashboard, Products, Inventory, Categories, Orders, Audit
│   ├── nginx.conf                  # Nginx static server + API proxy config
│   ├── vite.config.js
│   ├── .env.example
│   └── package.json
│
├── shared-resources/
│   ├── database/seed-data.js       # MongoDB seed (legacy v2)
│   │               seed-dynamodb.js # DynamoDB seed script
│   ├── migrate-to-dynamodb.js      # One-time migration helper (v2 → v3)
│   ├── healthcheck/healthcheck.sh
│   └── nginx/alb-listener.conf
│
└── deploy/
    ├── aws-userdata-app.sh         # EC2 user data — provisions both backend services + frontend
    └── aws-userdata-db.sh          # EC2 user data — MongoDB setup (v2 legacy)
```

---

## Architecture

### Overview

All user traffic enters through a single **CloudFront distribution** protected by **WAFv2**. CloudFront forwards requests to two origins: an **Application Load Balancer** (ALB) for all dynamic content and a private **S3 bucket** (via OAC) for product media. The ALB rejects any request that does not carry a secret `X-Custom-Header`, preventing direct access that bypasses CloudFront.

Behind the ALB, EC2 instances in private subnets run **both** Node.js microservices on the same host — the Identity Service on port 3001 and the Commerce Service on port 3002. Nginx on the frontend instances is a pure static file server; all API routing is handled by the ALB.

Product image uploads use **S3 presigned URLs**: the browser requests a short-lived PUT URL from the Commerce Service, then uploads directly to S3 — bypassing the backend entirely. The image is then served globally via the CloudFront distribution.

All commerce domain events are published to an **EventBridge custom bus**, which fans out to three Lambda consumers (audit logging, thumbnail generation, inventory monitoring) and directly to SNS alert topics.

---

### Architecture Diagram

```
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │  INTERNET                                                                   │
  └───────────┬───────────────────────────────────────────────┬─────────────────┘
              │ HTTPS                                          │ PUT (presigned URL)
              ▼                                               ▼
  ┌───────────────────────┐                       ┌─────────────────────────────┐
  │  AWS WAFv2 Web ACL    │                       │  S3 Product Images Bucket   │
  │  ┌─────────────────┐  │                       │  (private, versioned)       │
  │  │ CommonRuleSet   │  │                       │  products/  thumbnails/     │
  │  │ KnownBadInputs  │  │                       │  categories/                │
  │  │ IP Reputation   │  │                       └──────────────┬──────────────┘
  │  │ Rate Limit 100  │  │                                      │ OAC (SigV4)
  │  │ Geo Block (opt) │  │                                      │
  └───────────┬───────────┘                                      │
              │                                                  │
              ▼                                                  ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │                     CloudFront Distribution                               │
  │                                                                           │
  │  Path routing (ordered cache behaviors):                                  │
  │  /products/*  /thumbnails/*  /categories/*  /images/*  ──► S3 Origin     │
  │  /api/*  (CachingDisabled, AllViewer policy)            ──► ALB Origin    │
  │  /*  (default)                                          ──► ALB Origin    │
  │                                                                           │
  │  All ALB-bound requests inject:  X-Custom-Header: <secret>               │
  └──────────────────────────────┬────────────────────────────────────────────┘
                                 │ HTTP (custom header required on all paths)
                                 ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │              Application Load Balancer  (internet-facing)               │
  │              Accepts traffic from CloudFront prefix list only           │
  │                                                                         │
  │  Default action: 403 Forbidden (blocks direct access)                  │
  │                                                                         │
  │  Listener rules (all require X-Custom-Header match):                   │
  │  P5  — Host: arch.fanvault.com              ──► Lambda TG              │
  │  P10 — /api/auth*                           ──► Identity TG  (:3001)   │
  │  P15 — /api/admin*                          ──► Commerce TG  (:3002)   │
  │  P20 — /api/users*                          ──► Identity TG  (:3001)   │
  │  P30 — /api/products*                       ──► Commerce TG  (:3002)   │
  │  P40 — /api/orders*                         ──► Commerce TG  (:3002)   │
  │  P99 — /*                                   ──► Frontend TG  (:80)     │
  └───────┬────────────────────────┬──────────────────────┬─────────────────┘
          │                        │                       │
          ▼                        ▼                       ▼
  ┌──────────────┐    ┌────────────────────────┐    ┌──────────────┐
  │  Frontend    │    │    Backend ASG          │    │  Lambda      │
  │  ASG         │    │  (both services on      │    │  arch-page   │
  │              │    │   same EC2 instance)    │    │  (Node.js    │
  │  Nginx :80   │    │                         │    │   20.x)      │
  │  React SPA   │    │  ┌───────────────────┐  │    └──────┬───────┘
  │  (static)    │    │  │ Identity Service  │  │           │
  │              │    │  │ Node.js :3001     │  │           │ S3 GetObject
  │  Private     │    │  │ fanvault-auth     │  │           ▼
  │  frontend    │    │  │ (systemd)         │  │    ┌──────────────┐
  │  subnets     │    │  └────────┬──────────┘  │    │  S3 Arch     │
  └──────────────┘    │           │             │    │  Bucket      │
                      │  ┌────────▼──────────┐  │    └──────────────┘
                      │  │ Commerce Service  │  │
                      │  │ Node.js :3002     │  │
                      │  │ fanvault-commerce │  │
                      │  │ (systemd)         │  │
                      │  └────────┬──────────┘  │
                      │           │             │
                      │   Private backend        │
                      │   subnets               │
                      └───────────┬─────────────┘
                                  │
                  ┌───────────────┼────────────────────┐
                  │               │                    │
                  ▼               ▼                    ▼
  ┌─────────────────────┐  ┌──────────────┐   ┌──────────────────────┐
  │  DynamoDB (6 tables)│  │  SSM Param   │   │  EventBridge         │
  │  via VPC Gateway    │  │  Store       │   │  fanvault-event-bus  │
  │  Endpoint           │  │  /fanvault/* │   │  source:             │
  │                     │  │  (config)    │   │  fanvault.commerce   │
  │  fanvault-users     │  └──────────────┘   └──────────┬───────────┘
  │  fanvault-profiles  │                                 │
  │  fanvault-products  │                    ┌────────────┼────────────────┐
  │  fanvault-orders    │                    │            │                │
  │  fanvault-audit-logs│                    ▼            ▼                ▼
  │  fanvault-metadata  │           ┌─────────────┐ ┌──────────────┐ ┌──────────────┐
  └─────────────────────┘           │  Lambda     │ │  Lambda      │ │  Lambda      │
                                    │  Audit Log  │ │  Thumbnail   │ │  Inventory   │
                                    │  Consumer   │ │  Generator   │ │  Monitor     │
                                    └──────┬──────┘ └──────┬───────┘ └──────┬───────┘
                                           │               │                │
                                           ▼               ▼                ▼
                                    ┌─────────────────────────────────────────────────┐
                                    │  SNS Topics (KMS-encrypted)                     │
                                    │  fanvault-low-inventory-alerts                  │
                                    │  fanvault-order-failure-alerts                  │
                                    │  fanvault-product-upload-failures               │
                                    │  fanvault-admin-operational-alerts              │
                                    └─────────────────────────────────────────────────┘
                                                          │
                                                          ▼
                                    ┌─────────────────────────────────────────────────┐
                                    │  SQS Queues (fan-out, 14-day retention)         │
                                    │  + optional email subscription (alert_email)    │
                                    └─────────────────────────────────────────────────┘

  ┌──────────────┐
  │  Bastion     │  SSH jump host (public subnet)
  │  t3.micro    │  → connects to frontend and backend
  └──────────────┘    private instances via Bastion SG
```

---

### Traffic Routing Detail

| Entry Point | Request Type | Path | Handler |
|---|---|---|---|
| Browser | HTTPS | `/products/*`, `/thumbnails/*`, `/categories/*` | CloudFront → S3 (cached) |
| Browser | HTTPS | `/api/auth/*`, `/api/users/*` | CloudFront → ALB → Identity Service `:3001` |
| Browser | HTTPS | `/api/products/*`, `/api/orders/*`, `/api/admin/*` | CloudFront → ALB → Commerce Service `:3002` |
| Browser | HTTPS | `/*` (all other) | CloudFront → ALB → Nginx → React SPA |
| Admin | HTTPS | `arch.fanvault.com` | CloudFront → ALB → Lambda → S3 Arch Bucket |
| Admin browser | HTTPS PUT | presigned S3 URL | Direct to S3 (bypasses backend) |

---

## Services

### Identity Service (`fanvault-user-auth-service`)

**Port:** `3001` | **Runtime:** Node.js ≥ 18 | **Database:** DynamoDB (`fanvault-users`, `fanvault-profiles`)

Handles user registration, authentication (JWT access + refresh tokens), and profile management. Issues short-lived access tokens (15 min) and long-lived refresh tokens (7 days). The `JWT_SECRET` is shared read-only with the Commerce Service for token verification; `JWT_REFRESH_SECRET` stays in this service only.

On startup, optionally fetches `JWT_SECRET` and `JWT_REFRESH_SECRET` from AWS Secrets Manager (enabled by `USE_SECRETS_MANAGER=true`). Validates connectivity to the `fanvault-users` DynamoDB table before accepting traffic.

**Rate limiting:** `/api/auth/*` — 100 requests per 15 minutes per IP.

#### API Reference

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Service health check — returns DB connectivity status |
| `POST` | `/api/auth/register` | None | Register new user (email + password) |
| `POST` | `/api/auth/login` | None | Login — returns `accessToken` + `refreshToken` |
| `POST` | `/api/auth/refresh` | None | Exchange refresh token for a new access token |
| `GET` | `/api/auth/verify` | Bearer | Validate and decode access token |
| `POST` | `/api/auth/logout` | None | Stateless logout (client-side token discard) |
| `GET` | `/api/users/me` | Bearer | Fetch own profile |
| `POST` | `/api/users/me` | Bearer | Create profile (post-registration) |
| `PATCH` | `/api/users/me` | Bearer | Update profile fields |
| `POST` | `/api/users/me/addresses` | Bearer | Add shipping address |
| `DELETE` | `/api/users/me/addresses/:id` | Bearer | Remove shipping address |

#### Environment Variables

| Variable | Required | Secret | Default | Description |
|---|---|---|---|---|
| `PORT` | Yes | No | `3001` | Express listening port |
| `NODE_ENV` | Yes | No | — | `production` / `development` |
| `AWS_REGION` | Yes | No | `us-east-1` | Region for DynamoDB + Secrets Manager |
| `DYNAMODB_TABLE_USERS` | Yes | No | `fanvault-users` | DynamoDB table for auth credentials |
| `DYNAMODB_TABLE_PROFILES` | Yes | No | `fanvault-profiles` | DynamoDB table for user profiles |
| `JWT_SECRET` | Yes | **Yes** | — | Access token signing key (≥ 32 chars, shared with Commerce) |
| `JWT_EXPIRES_IN` | No | No | `15m` | Access token TTL |
| `JWT_REFRESH_SECRET` | Yes | **Yes** | — | Refresh token signing key (different from JWT_SECRET) |
| `JWT_REFRESH_EXPIRES_IN` | No | No | `7d` | Refresh token TTL |
| `CORS_ORIGIN` | Yes | No | — | Allowed client origin |
| `USE_SECRETS_MANAGER` | No | No | `false` | Fetch JWT secrets from Secrets Manager at startup |
| `SECRET_ID` | No | No | `production/fanvault-auth` | Secrets Manager secret ID |

---

### Commerce Service (`fanvault-commerce-service`)

**Port:** `3002` | **Runtime:** Node.js ≥ 18 | **Database:** DynamoDB (`fanvault-products`, `fanvault-orders`, `fanvault-audit-logs`, `fanvault-metadata`)

Handles the product catalog, order lifecycle, admin operations, and product image management. Reads S3 bucket config from **SSM Parameter Store** at runtime (cached after first fetch) — no S3 credentials are hardcoded.

**Image uploads** use **presigned PUT URLs**: the admin requests a URL from `GET /api/products/upload-url`, the browser uploads directly to S3, then the product is created/updated with the resulting S3 key. Images are served publicly via CloudFront (OAC). Accepted types: JPEG, PNG, WebP, GIF. Max size: 5 MB per file.

**Event publishing:** every product create/update, order placement, and inventory threshold breach publishes a domain event to the `fanvault-event-bus` EventBridge bus (source: `fanvault.commerce`). EventBridge fans the events out to audit-logging, thumbnail-generation, and inventory-monitoring Lambda consumers.

**Audit logging:** all admin actions (product create/update/delete, stock updates, image URL generation, category changes) are written to `fanvault-audit-logs` as fire-and-forget — failures never block the request.

#### API Reference

**Products**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Service health check |
| `GET` | `/api/products` | None | List products (filters: `category`, `franchise`, `franchiseType`, `search`, `minPrice`, `maxPrice`; cursor pagination via `lastKey`) |
| `GET` | `/api/products/bulk` | None | Batch fetch products by comma-separated `ids` |
| `GET` | `/api/products/:id` | None | Single product detail |
| `POST` | `/api/products` | Admin | Create product |
| `PATCH` | `/api/products/:id` | Admin | Update product fields / stock |
| `DELETE` | `/api/products/:id` | Admin | Soft-delete (deactivate) product |
| `GET` | `/api/products/upload-url` | Admin | Get S3 presigned PUT URL (`fileType`, `fileSize`, `folder` query params) |

**Orders**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/orders` | Bearer | Place order — calculates subtotal + 18% GST + ₹99 shipping (free above ₹1999) |
| `GET` | `/api/orders/my` | Bearer | Paginated list of own orders |
| `GET` | `/api/orders/:id` | Bearer | Order detail |
| `POST` | `/api/orders/:id/cancel` | Bearer | Cancel own pending order |
| `GET` | `/api/orders` | Admin | All orders (admin) |
| `PATCH` | `/api/orders/:id/status` | Admin | Update order status |

**Admin**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/admin/audit-logs` | Admin | Query audit log entries |
| `GET` | `/api/admin/inventory` | Admin | Full inventory view |
| `PATCH` | `/api/admin/inventory/:productId` | Admin | Update product stock |
| `GET` | `/api/admin/metadata/:metaType` | Admin | List categories or franchises |
| `POST` | `/api/admin/metadata/:metaType` | Admin | Create/update category or franchise |
| `DELETE` | `/api/admin/metadata/:metaType/:metaId` | Admin | Deactivate category or franchise |

#### Environment Variables

| Variable | Required | Secret | Default | Description |
|---|---|---|---|---|
| `PORT` | Yes | No | `3002` | Express listening port |
| `NODE_ENV` | Yes | No | — | `production` / `development` |
| `AWS_REGION` | Yes | No | `us-east-1` | Region for all AWS SDK clients |
| `DYNAMODB_TABLE_PRODUCTS` | Yes | No | `fanvault-products` | Products table |
| `DYNAMODB_TABLE_ORDERS` | Yes | No | `fanvault-orders` | Orders table |
| `DYNAMODB_TABLE_AUDIT_LOGS` | No | No | `fanvault-audit-logs` | Audit log table |
| `DYNAMODB_TABLE_METADATA` | No | No | `fanvault-metadata` | Categories/franchises table |
| `JWT_SECRET` | Yes | **Yes** | — | Verify access tokens (must match Identity Service) |
| `SSM_S3_BUCKET_PATH` | No | No | `/fanvault/s3/bucket` | SSM path to product images bucket name |
| `SSM_S3_REGION_PATH` | No | No | `/fanvault/s3/region` | SSM path to bucket region |
| `SSM_CLOUDFRONT_URL_PATH` | No | No | `/fanvault/s3/cloudfront_url` | SSM path to CloudFront domain for image URLs |
| `EVENTBRIDGE_BUS_NAME` | No | No | `fanvault-event-bus` | EventBridge custom bus name |
| `CORS_ORIGIN` | Yes | No | — | Allowed client origin |
| `USE_SECRETS_MANAGER` | No | No | `false` | Fetch JWT secret from Secrets Manager |
| `SECRET_ID` | No | No | `production/fanvault-auth` | Secrets Manager secret ID |

---

### Frontend (`fanvault-frontend`)

**Build tool:** Vite 6 | **Framework:** React 18 | **Runtime:** Nginx (static file server)

The SPA communicates with the backend exclusively via relative API paths (`/api/*`). Nginx proxies these paths to the Identity and Commerce services running on `127.0.0.1`. No backend URLs appear in the frontend bundle.

**Code splitting** (Vite `manualChunks`):
- `vendor` — React, React DOM, React Router
- `utils` — Axios

#### Pages & Routes

| Route | Component | Access |
|---|---|---|
| `/` | `HomePage` | Public |
| `/login` | `LoginPage` | Guest only (redirects to `/` if logged in) |
| `/register` | `RegisterPage` | Guest only |
| `/products` | `ProductsPage` | Public |
| `/products/:productId` | `ProductDetailPage` | Public |
| `/cart` | `CartPage` | Public (local cart state) |
| `/checkout` | `CheckoutPage` | Protected |
| `/orders` | `OrdersPage` | Protected |
| `/orders/:id` | `OrderDetailPage` | Protected |
| `/profile` | `ProfilePage` | Protected |
| `/admin` | `AdminDashboard` | Admin role |
| `/admin/products` | `AdminProducts` | Admin role |
| `/admin/products/new` | `AdminProductForm` | Admin role |
| `/admin/products/:id/edit` | `AdminProductForm` | Admin role |
| `/admin/inventory` | `AdminInventory` | Admin role |
| `/admin/categories` | `AdminCategories` | Admin role |
| `/admin/orders` | `AdminOrders` | Admin role |
| `/admin/audit` | `AdminAudit` | Admin role |

**Route protection:**
- `ProtectedRoute` — redirects to `/login` if no authenticated user
- `AdminRoute` — additionally checks `user.role === 'admin'`
- `GuestRoute` — redirects to `/` if already authenticated

#### Build & Nginx

```bash
cd fanvault-frontend
npm install
npm run build          # outputs to dist/
```

Nginx serves `dist/` as the web root. The catch-all `try_files $uri $uri/ /index.html` enables client-side React Router navigation. API paths proxy to localhost backend services.

#### Environment Variables (build-time only)

| Variable | Required | Description |
|---|---|---|
| `VITE_APP_NAME` | No | App display name in browser tab (default: `FanVault`) |

---

## Event-Driven Pipeline

The Commerce Service publishes domain events to EventBridge after state changes. Events are fire-and-forget — publication failures are logged but never block the HTTP response.

| Event (DetailType) | Trigger | Consumers |
|---|---|---|
| `ProductCreated` | Admin creates a product | Audit logging Lambda, Thumbnail generator Lambda |
| `ProductUpdated` | Admin updates a product | Audit logging Lambda, Thumbnail generator Lambda |
| `InventoryLow` | Stock ≤ 5 on create or update | Audit logging Lambda, Inventory monitor Lambda → SNS low-inventory topic |
| `OrderPlaced` | Customer places an order | Audit logging Lambda |

All EventBridge rules: retry up to 3 attempts over 1 hour; undeliverable events land in the SQS DLQ (`fanvault-event-dlq`, 14-day retention).

---

## Data Model

All tables use **PAY_PER_REQUEST** billing, KMS encryption, and PITR.

| Table | PK | SK | Key GSIs | Service |
|---|---|---|---|---|
| `fanvault-users` | `userId` | — | `email-index` | Identity |
| `fanvault-profiles` | `userId` | — | — | Identity |
| `fanvault-products` | `productId` | — | `sku-index`, `category-franchise-index` | Commerce |
| `fanvault-orders` | `orderId` | — | `userId-createdAt-index`, `orderNumber-index`, `status-createdAt-index` | Commerce |
| `fanvault-audit-logs` | `logId` | — | `entityType-timestamp-index`, `adminId-timestamp-index` | Commerce (1-day TTL) |
| `fanvault-metadata` | `metaType` | `metaId` | — | Commerce (categories/franchises) |

---

## Local Development

### Prerequisites
- Node.js ≥ 18
- AWS credentials configured (for DynamoDB, SSM, EventBridge, S3, SNS)
- DynamoDB tables already provisioned (via the Terraform repo)

### Running the Backend Services

```bash
# Identity Service
cd fanvault-user-auth-service
cp .env.example .env          # fill in table names and JWT secrets
npm install
npm run dev                   # nodemon on :3001

# Commerce Service (new terminal)
cd fanvault-commerce-service
cp .env.example .env          # fill in table names, JWT secret, SSM paths
npm install
npm run dev                   # nodemon on :3002
```

### Running the Frontend

```bash
cd fanvault-frontend
npm install
npm run dev                   # Vite dev server on :5173
```

> **Note:** In dev mode Vite does not go through Nginx, so configure a Vite proxy in `vite.config.js` or set the API base URL to point directly at the backend ports if needed.

---

## Production Deployment (EC2 / Terraform-managed ASGs)

The Terraform repo ([Terraform-Fanvault-Infra](../Terraform-Fanvault-Infra/)) provisions all AWS infrastructure. EC2 instances are bootstrapped via user data scripts.

### Backend + Frontend (Monolithic App Node)

Both Node.js services and Nginx run on the same EC2 instance (managed by the backend ASG). The instance pulls code from GitHub at boot, installs dependencies, builds the frontend, and starts systemd services.

```bash
# Managed automatically by EC2 user data (deploy/aws-userdata-app.sh)
# Manually replicate on a golden instance:

# 1. Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs nginx

# 2. Clone and deploy Identity Service
sudo mkdir -p /var/www/fanvault-user-auth-service
sudo rsync -av ./fanvault-user-auth-service/ /var/www/fanvault-user-auth-service/
cd /var/www/fanvault-user-auth-service && sudo npm install --omit=dev
sudo cp deploy/fanvault-auth.service /etc/systemd/system/
sudo systemctl enable --now fanvault-auth

# 3. Clone and deploy Commerce Service
sudo mkdir -p /var/www/fanvault-commerce-service
sudo rsync -av ./fanvault-commerce-service/ /var/www/fanvault-commerce-service/
cd /var/www/fanvault-commerce-service && sudo npm install --omit=dev
sudo cp deploy/fanvault-commerce.service /etc/systemd/system/
sudo systemctl enable --now fanvault-commerce

# 4. Build and deploy Frontend
cd fanvault-frontend && npm install && npm run build
sudo rsync -av dist/ /var/www/fanvault-frontend/dist/
sudo cp nginx.conf /etc/nginx/sites-available/fanvault
sudo ln -sf /etc/nginx/sites-available/fanvault /etc/nginx/sites-enabled/fanvault
sudo systemctl enable --now nginx
```

### Service Management

```bash
# Check service status
sudo systemctl status fanvault-auth
sudo systemctl status fanvault-commerce

# Restart a service
sudo systemctl restart fanvault-auth

# View logs (last 100 lines)
sudo journalctl -u fanvault-auth -n 100
sudo journalctl -u fanvault-commerce -n 100
```

### SSH Access (via Bastion)

```bash
# Add key to agent (required for agent forwarding)
ssh-add fanvault-key.pem

# Jump to a private backend instance
ssh -A -J ubuntu@<BASTION_PUBLIC_IP> ubuntu@<BACKEND_PRIVATE_IP>
```

---

## Health Checks

| Endpoint | Port | Expected Response |
|---|---|---|
| `GET /health` | `3001` | `{"status":"ok","service":"fanvault-user-auth-service","database":"dynamodb"}` |
| `GET /health` | `3002` | `{"status":"ok","service":"fanvault-commerce-service","database":"dynamodb"}` |
| `GET /health` | `80` (Nginx) | `{"status":"ok","service":"fanvault-frontend"}` |

```bash
# From inside a backend EC2 instance:
curl http://localhost:3001/health
curl http://localhost:3002/health

# Via ALB (from anywhere with HTTPS access):
curl https://<ALB_DNS_NAME>/api/auth/verify
curl https://<ALB_DNS_NAME>/api/products
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite 6, React Router v6, Axios, react-hot-toast, lucide-react |
| Backend | Node.js ≥ 18, Express 4, Helmet, Morgan, express-rate-limit, express-validator |
| Auth | JWT (jsonwebtoken), bcryptjs |
| Database | AWS DynamoDB (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`) |
| Object Storage | AWS S3 + S3 Request Presigner |
| CDN | AWS CloudFront (OAC for S3, custom header for ALB) |
| Events | AWS EventBridge (custom bus) |
| Alerts | AWS SNS (KMS-encrypted) + SQS fan-out |
| Config | AWS SSM Parameter Store |
| Secrets | AWS Secrets Manager (optional, production) |
| Web Server | Nginx (static files + local API proxy) |
| Process Manager | systemd |
| Infrastructure | Terraform ≥ 1.5, AWS provider ~5.0 |
| CI/CD | GitHub Actions + OIDC (no long-lived keys) |

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `DynamoDB health-check failed` at startup | Missing table or wrong region | Verify `DYNAMODB_TABLE_USERS` name and `AWS_REGION` match provisioned tables |
| `401 Unauthorized` on all API calls | JWT secret mismatch between services | Ensure `JWT_SECRET` is identical in both `.env` files |
| Images returning 403 | CloudFront OAC not set up, or S3 bucket policy missing | Check CloudFront distribution OAC config and S3 bucket policy in Terraform |
| Presigned URL PUT fails (403) | S3 CORS policy | Verify `allowed_origins` in the `aws_s3_bucket_cors_configuration` resource |
| EventBridge events not delivered | `EVENTBRIDGE_BUS_NAME` mismatch | Confirm the bus name matches the Terraform output `event_bus_name` |
| Nginx `502 Bad Gateway` on `/api/*` | Backend service not running | `systemctl status fanvault-auth` / `fanvault-commerce`; check `journalctl` |
| `403 Forbidden` on ALB direct access | Correct — ALB blocks requests without `X-Custom-Header` | Route traffic through CloudFront |
