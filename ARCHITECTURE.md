# FanVault v2 — Architecture Reference

## Table of Contents
1. [ASCII Architecture Diagram](#ascii-architecture-diagram)
2. [Service Consolidation Map](#service-consolidation-map)
3. [Service Communication Matrix](#service-communication-matrix)
4. [API Reference](#api-reference)
5. [Environment Variable Matrix](#environment-variable-matrix)
6. [Database Architecture](#database-architecture)
7. [AWS Networking & VPC Layout](#aws-networking--vpc-layout)
8. [Security Group Matrix](#security-group-matrix)
9. [Route53 Private DNS Strategy](#route53-private-dns-strategy)
10. [EC2 Sizing Recommendations](#ec2-sizing-recommendations)
11. [Startup & Dependency Order](#startup--dependency-order)
12. [Deployment Validation Steps](#deployment-validation-steps)
13. [Rollback Notes](#rollback-notes)

---

## ASCII Architecture Diagram
<img width="3075" height="3263" alt="architecture png" src="https://github.com/user-attachments/assets/3fbbf997-773c-4d25-903a-7ec511e4112f" />

```text
                          ┌──────────────────────────────────────────────────────────────┐
                          │                  AWS VPC  (10.0.0.0/16)                      │
                          │                                                              │
                          │  ┌────────────────────────────────────────────────────────┐ │
                          │  │              PUBLIC SUBNETS (10.0.1.0/24)              │ │
                          │  │                                                        │ │
   Users (HTTPS)          │  │   ┌──────────────────────┐    ┌──────────────────┐    │ │
   ─────────────────────► │  │   │  Internet-facing ALB  │    │   NAT Gateway    │    │ │
                          │  │   │  (HTTP→HTTPS redirect │    │  (for private EC2│    │ │
                          │  │   │   + Path Routing)     │    │   outbound only) │    │ │
                          │  │   └──────────┬───────────┘    └──────────────────┘    │ │
                          │  └──────────────┼─────────────────────────────────────────┘ │
                          │                 │
                          │        ┌────────┴────────┬───────────────────┐
                          │        │                 │                   │
                          │  ┌─────▼─────┐     ┌─────▼─────┐       ┌─────▼─────┐
                          │  │  Frontend │     │ Identity  │       │ Commerce  │
                          │  │ TargetGrp │     │ TargetGrp │       │ TargetGrp │
                          │  │    /*     │     │ /api/auth │       │ /api/prod │
                          │  └─────┬─────┘     └─────┬─────┘       └─────┬─────┘
                          │        │                 │                   │
                          │  ┌─────▼─────┐     ┌─────▼─────┐       ┌─────▼─────┐
                          │  │ FRONTEND  │     │ IDENTITY  │       │ COMMERCE  │
                          │  │ EC2 ASG   │     │ EC2 ASG   │       │ EC2 ASG   │
                          │  │ :80       │     │ :3001     │       │ :3002     │
                          │  └───────────┘     └─────┬─────┘       └─────┬─────┘
                          │                          │                   │
                          │                          └─────────┬─────────┘
                          │                                    │
                          │  ┌─────────────────────────────────▼──────────────────────┐ │
                          │  │             ISOLATED DB SUBNETS (10.0.31.0/24)         │ │
                          │  │                                                        │ │
                          │  │   ┌────────────────────────────────────────────────┐  │ │
                          │  │   │         MongoDB EC2 (t3.medium)                │  │ │
                          │  │   │         db.fanvault.internal : 27017           │  │ │
                          │  │   └────────────────────────────────────────────────┘  │ │
                          │  └────────────────────────────────────────────────────────┘ │
                          └──────────────────────────────────────────────────────────────┘
```

---

## Service Consolidation Map

| Original Service | Lines of Responsibility | Absorbed Into |
|---|---|---|
| `FanVault-authservice` | JWT issue, password hashing, token refresh | `fanvault-user-auth-service` |
| `FanVault-UserService` | Profile CRUD, addresses, preferences | `fanvault-user-auth-service` |
| `FanVault-ProductService` | Catalog CRUD, stock, text search | `fanvault-commerce-service` |
| `FanVault-OrdersService` | Checkout, pricing, order tracking | `fanvault-commerce-service` |
| `FanVault-frontend` | React SPA, API client | `fanvault-frontend` |
| `FanVault-EmailService` | Transactional email | **Omitted entirely** |

**What was removed:**
- `x-internal-secret` header and internal `GET /api/users/:authId` route (no longer needed — auth and user share the same process)
- All outbound HTTP calls to `EmailService` (replaced by structured `console.log` events)
- Docker-related deployment tooling (containers optional, not required)
- Kubernetes / Helm / service-mesh infrastructure

---

## Service Communication Matrix

```
┌────────────────────────┬───────────────────────────┬────────────────┬───────────────────────────┐
│ Source                 │ Target                    │ Protocol       │ Purpose                   │
├────────────────────────┼───────────────────────────┼────────────────┼───────────────────────────┤
│ Browser (HTTPS)        │ ALB                       │ HTTPS :443     │ All user requests         │
│ ALB                    │ Frontend Target Group     │ HTTP :80       │ /* (Static files)         │
│ ALB                    │ Identity Target Group     │ HTTP :3001     │ /api/auth/* /api/users/*  │
│ ALB                    │ Commerce Target Group     │ HTTP :3002     │ /api/products/* /api/orders│
│ Identity Service       │ MongoDB                   │ mongodb :27017 │ Read/write auth+profiles  │
│ Commerce Service       │ MongoDB                   │ mongodb :27017 │ Read/write products+orders│
└────────────────────────┴───────────────────────────┴────────────────┴───────────────────────────┘
```

**No service-to-service REST calls exist at runtime.**

---

## API Reference

### Identity Service (`fanvault-user-auth-service`) — Port 3001

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Service health check |
| `POST` | `/api/auth/register` | None | Register new user |
| `POST` | `/api/auth/login` | None | Login, receive tokens |
| `POST` | `/api/auth/refresh` | None | Exchange refresh → access token |
| `GET` | `/api/auth/verify` | Bearer | Validate token |
| `POST` | `/api/auth/logout` | None | Stateless logout |
| `GET` | `/api/users/me` | Bearer | Get own profile |
| `POST` | `/api/users/me` | Bearer | Create profile post-registration |
| `PATCH` | `/api/users/me` | Bearer | Update profile fields |
| `POST` | `/api/users/me/addresses` | Bearer | Add shipping address |
| `DELETE` | `/api/users/me/addresses/:id` | Bearer | Remove shipping address |

### Commerce Service (`fanvault-commerce-service`) — Port 3002

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Service health check |
| `GET` | `/api/products` | None | List products (filterable) |
| `GET` | `/api/products/bulk` | None | Batch fetch by IDs |
| `GET` | `/api/products/:id` | None | Single product detail |
| `POST` | `/api/products` | Admin | Create product |
| `PATCH` | `/api/products/:id` | Admin | Update product / stock |
| `DELETE` | `/api/products/:id` | Admin | Soft-delete product |
| `POST` | `/api/orders` | Bearer | Place order (checkout) |
| `GET` | `/api/orders/my` | Bearer | User's own orders |
| `GET` | `/api/orders/:id` | Bearer | Order detail |
| `GET` | `/api/orders` | Admin | All orders |
| `PATCH` | `/api/orders/:id/status` | Admin | Update order status |
| `POST` | `/api/orders/:id/cancel` | Bearer | Cancel own order |

---

## Environment Variable Matrix

### `fanvault-user-auth-service`

| Variable | Purpose | Required | Secret | Example |
|---|---|---|---|---|
| `PORT` | Express port | Yes | No | `3001` |
| `NODE_ENV` | Runtime context | Yes | No | `production` |
| `MONGO_URI` | MongoDB connection string | Yes | **Yes** | `mongodb://user:pass@db.fanvault.internal:27017/fanvault_db?authSource=fanvault_db` |
| `JWT_SECRET` | Access token signing key (shared with Commerce) | Yes | **Yes** | `<32+ random bytes>` |
| `JWT_EXPIRES_IN` | Access token TTL | No | No | `15m` |
| `JWT_REFRESH_SECRET` | Refresh token signing key | Yes | **Yes** | `<different 32+ bytes>` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL | No | No | `7d` |
| `CORS_ORIGIN` | Allowed client origins | Yes | No | `https://fanvault.example.com` |

### `fanvault-commerce-service`

| Variable | Purpose | Required | Secret | Example |
|---|---|---|---|---|
| `PORT` | Express port | Yes | No | `3002` |
| `NODE_ENV` | Runtime context | Yes | No | `production` |
| `MONGO_URI` | MongoDB connection string | Yes | **Yes** | `mongodb://user:pass@db.fanvault.internal:27017/fanvault_db?authSource=fanvault_db` |
| `JWT_SECRET` | Access token verification key (must match Identity Service) | Yes | **Yes** | `<same value as Identity Service>` |
| `CORS_ORIGIN` | Allowed client origins | Yes | No | `https://fanvault.example.com` |

### `fanvault-frontend`

| Variable | Purpose | Required | Secret | Example |
|---|---|---|---|---|
| `VITE_APP_NAME` | App display name (build-time only) | No | No | `FanVault` |

> **Note:** No backend URLs in the frontend bundle. Nginx handles all routing using private DNS.

---

## Database Architecture

### Consolidated Database: `fanvault_db`

```
MongoDB Instance: db.fanvault.internal:27017
Database:         fanvault_db

Collections:
  authusers      ← AuthUser schema (email, password hash, role, isActive)
  userprofiles   ← UserProfile schema (authId FK, name, phone, addresses[])
  products       ← Product schema (name, sku, category, franchise, stock, rating)
  orders         ← Order schema (userId, items[], shippingAddress, total, status)
```

### Migration Order (from old 6-service setup)
1. `products` (no foreign keys, independent)
2. `authusers` (credentials baseline)
3. `userprofiles` (depends on authusers.\_id)
4. `orders` (depends on authusers.\_id as userId)

### MongoDB Setup Commands (on DB EC2)
```bash
# Install MongoDB 7.x
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
  gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] \
  https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | \
  tee /etc/apt/sources.list.d/mongodb-org-7.0.list
apt-get update && apt-get install -y mongodb-org

# Bind to private IP only (replace with actual private IP)
sed -i 's/bindIp: 127.0.0.1/bindIp: 0.0.0.0/' /etc/mongod.conf

# Enable auth
cat >> /etc/mongod.conf << 'EOF'
security:
  authorization: enabled
EOF

systemctl enable mongod && systemctl start mongod

# Create admin user
mongosh --eval '
  db = db.getSiblingDB("admin");
  db.createUser({
    user: "dbadmin",
    pwd: "CHANGE_ME_STRONG_PASSWORD",
    roles: [{ role: "userAdminAnyDatabase", db: "admin" }, "readWriteAnyDatabase"]
  });
'

# Create application user
mongosh -u dbadmin -p CHANGE_ME_STRONG_PASSWORD --authenticationDatabase admin --eval '
  db = db.getSiblingDB("fanvault_db");
  db.createUser({
    user: "dbuser",
    pwd: "CHANGE_ME_APP_PASSWORD",
    roles: [{ role: "readWrite", db: "fanvault_db" }]
  });
'
```

---

## AWS Networking & VPC Layout

```
VPC CIDR: 10.0.0.0/16
Region:   ap-south-1 (Mumbai) — or your preferred region

Subnet                    CIDR             AZ          Purpose
──────────────────────────────────────────────────────────────────────
public-1a                 10.0.1.0/24      ap-south-1a  ALB, NAT GW
public-1b                 10.0.2.0/24      ap-south-1b  ALB (HA)
frontend-private-1a       10.0.11.0/24     ap-south-1a  Frontend EC2
frontend-private-1b       10.0.12.0/24     ap-south-1b  Frontend EC2 (HA)
backend-private-1a        10.0.21.0/24     ap-south-1a  Identity + Commerce EC2
backend-private-1b        10.0.22.0/24     ap-south-1b  Backend EC2 (HA)
db-private-1a             10.0.31.0/24     ap-south-1a  MongoDB primary
db-private-1b             10.0.32.0/24     ap-south-1b  MongoDB replica (optional)
```

---

## Security Group Matrix

```
┌──────────────────────────┬─────────────────────────────┬──────────┬────────┐
│ Security Group           │ Inbound From                │ Port     │ Proto  │
├──────────────────────────┼─────────────────────────────┼──────────┼────────┤
│ fanvault-alb-sg          │ 0.0.0.0/0                   │ 80, 443  │ TCP    │
│ fanvault-frontend-sg     │ fanvault-alb-sg              │ 80       │ TCP    │
│ fanvault-backend-sg      │ fanvault-frontend-sg         │ 3001     │ TCP    │
│ fanvault-backend-sg      │ fanvault-frontend-sg         │ 3002     │ TCP    │
│ fanvault-db-sg           │ fanvault-backend-sg          │ 27017    │ TCP    │
│ fanvault-bastion-sg      │ Operator CIDR (restrict!)    │ 22       │ TCP    │
│ fanvault-backend-sg      │ fanvault-bastion-sg          │ 22       │ TCP    │
│ fanvault-db-sg           │ fanvault-bastion-sg          │ 22       │ TCP    │
└──────────────────────────┴─────────────────────────────┴──────────┴────────┘

Egress: All security groups allow all outbound (0.0.0.0/0) to enable NAT/npm installs.
        Lock down egress in production if required by policy.
```

---

## Route53 Private DNS Strategy

**Private Hosted Zone:** `fanvault.internal`  
**Associated VPC:** Your custom VPC ID

| DNS Record | Type | Value | Resolves To |
|---|---|---|---|
| `db.fanvault.internal` | A | `10.0.31.100` | MongoDB EC2 private IP |

> **Note on App Services:** Previously, we used `auth-svc` and `commerce-svc` private DNS records for Nginx. Since moving to an ALB-direct routing model, these are obsolete. The ALB balances traffic natively using Target Groups connected to Auto Scaling Groups.

---

## EC2 Sizing Recommendations

| Service | Instance Type | vCPU | RAM | Storage | Notes |
|---|---|---|---|---|---|
| Frontend (Nginx) | `t3.small` | 2 | 2 GB | 20 GB gp3 | Scales via ASG |
| Identity Service | `t3.small` | 2 | 2 GB | 20 GB gp3 | Stateless — Scales via ASG |
| Commerce Service | `t3.small` | 2 | 2 GB | 20 GB gp3 | Stateless — Scales via ASG |
| MongoDB | `t3.medium` | 2 | 4 GB | 50 GB gp3 | Single instance / Primary DB |

All instances: **Ubuntu 22.04 LTS** (HVM, SSD).

---

## Auto Scaling Strategy

The architecture natively supports AWS Auto Scaling Groups (ASG) to handle high availability and load scaling without manual intervention:

1. **AMIs:** You create Amazon Machine Images from your fully provisioned EC2 instances. Because systemd is enabled, the processes launch instantly on boot.
2. **Launch Templates:** You define templates referencing these AMIs and the respective security groups (e.g., `fanvault-backend-sg`).
3. **ASGs:** Spanning multiple subnets (`backend-private-1a`, `backend-private-1b`), ASGs ensure instances are balanced across Availability Zones.
4. **Target Groups:** ASGs automatically register new instances directly with the ALB Target Groups (`fanvault-frontend-tg`, `fanvault-identity-tg`, `fanvault-commerce-tg`).

---

## Startup & Dependency Order

```
Startup dependency chain:
  MongoDB (DB subnet)
    └── Identity Service (Backend subnet)
    └── Commerce Service (Backend subnet)
          └── Frontend / Nginx (Frontend subnet)
                └── ALB health check passes
                      └── Route53 public record → ALB DNS
                            └── End-to-end validation
```

**Runtime dependencies** (steady state — no startup dependency):
- Frontend Nginx must resolve `auth-svc.fanvault.internal` and `commerce-svc.fanvault.internal`
- Identity and Commerce services must resolve `db.fanvault.internal`
- No service polls any other service — all are stateless after startup

**Health check dependency order:**
1. `mongosh --host db.fanvault.internal --eval "db.adminCommand('ping')"`
2. `curl http://auth-svc.fanvault.internal:3001/health`
3. `curl http://commerce-svc.fanvault.internal:3002/health`
4. `curl http://<frontend-private-ip>/health`
5. `curl https://<alb-dns-name>/health`

---

## Deployment Validation Steps

### Step 1 — MongoDB
```bash
# From Bastion host or DB EC2
mongosh "mongodb://dbuser:PASSWORD@db.fanvault.internal:27017/fanvault_db?authSource=fanvault_db" \
  --eval "db.adminCommand('ping')"
# Expected: { ok: 1 }
```

### Step 2 — Identity Service
```bash
# From Identity EC2 instance
curl -s http://localhost:3001/health | python3 -m json.tool
# Expected: {"status":"ok","service":"fanvault-user-auth-service","timestamp":"..."}

# Register a test user (via ALB)
curl -s -X POST https://<alb-dns-name>/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test@12345"}'
# Expected: 201 with accessToken
```

### Step 3 — Commerce Service
```bash
# From Commerce EC2 instance
curl -s http://localhost:3002/health | python3 -m json.tool
# Expected: {"status":"ok","service":"fanvault-commerce-service","timestamp":"..."}

# Test via ALB
curl -s https://<alb-dns-name>/api/products | python3 -m json.tool
# Expected: products array with 5 seeded items
```

### Step 4 — Frontend / Nginx
```bash
# Test Nginx config on Frontend EC2
nginx -t
# Expected: syntax is ok / test is successful

# Test serving from Frontend EC2
curl -s http://localhost/health
# Expected: 200 OK responses
```

### Step 5 — ALB
```bash
# From anywhere with internet access
curl -s https://<alb-dns-name>/health
curl -s https://<alb-dns-name>/api/products
# Expected: 200 OK, JSON responses
```

---

## Rollback Notes

| Failure Point | Rollback Action |
|---|---|
| MongoDB seeding failed | Re-run `seed-data.js` — it drops and repopulates each collection |
| Identity Service crash | `systemctl restart fanvault-auth` / check `journalctl -u fanvault-auth -n 100` |
| Commerce Service crash | `systemctl restart fanvault-commerce` / check `journalctl -u fanvault-commerce -n 100` |
| Nginx bad config | `nginx -t` before reloading; restore from backup with `cp /etc/nginx/sites-available/fanvault.bak /etc/nginx/sites-available/fanvault` |
| Full rollback | Deregister v2 EC2 instances from ALB target group, re-register original instances |
| DB data corruption | Restore from MongoDB snapshot / EBS snapshot taken before migration |

> **Recommendation:** Take EBS snapshots of the DB volume before every migration step.
