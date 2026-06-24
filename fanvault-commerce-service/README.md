# fanvault-commerce-service

Product catalog, order management, admin operations, and event publishing for FanVault v3. Backed by **DynamoDB**, with **EventBridge** for event-driven consumers, **SNS** for operational alerts, and **S3 presigned URLs** for direct browser image uploads.

- **Port:** `3002`
- **Runtime:** Node.js ≥ 18, Express 4
- **Auth:** AWS Cognito JWT (decoded via middleware — same pattern as user-service)
- **Database:** DynamoDB (4 tables: products, orders, audit-logs, metadata)
- **Events:** EventBridge custom bus (`fanvault-event-bus`)
- **Alerts:** SNS topics (KMS-encrypted)

---

## How It Works

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  fanvault-commerce-service  — Service Architecture                           │
└──────────────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────────┐
   HTTP Client ────►│  Express  :3002                      │
                    │  helmet + cors + morgan               │
                    │                                      │
                    │  /api/products/*  → product.routes   │
                    │  /api/orders/*    → order.routes     │
                    │  /api/admin/*     → admin.routes     │
                    └───────────────────────────────────────┘
                                      │
                    ┌─────────────────┼──────────────────┐
                    │                 │                  │
                    ▼                 ▼                  ▼
           ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐
           │ DynamoDB     │  │ EventBridge  │  │ S3 Presigned URL     │
           │              │  │ (fire-and-   │  │                      │
           │ products     │  │  forget)     │  │ GET /upload-url      │
           │ orders       │  │              │  │ → PutObject presigned│
           │ audit-logs   │  │ ProductCrtd  │  │   URL (15min expiry) │
           │ metadata     │  │ ProductUpd   │  │                      │
           └──────────────┘  │ InventoryLow │  │ Browser uploads      │
                             │ OrderPlaced  │  │ directly to S3       │
                             └──────┬───────┘  └──────────────────────┘
                                    │
                             ┌──────▼───────┐
                             │ SNS Topics   │
                             │ (direct for  │
                             │  order fails │
                             │  + admin ops)│
                             └──────────────┘
```

### Request → DynamoDB → Event Flow

```
POST /api/products (admin)
  │
  ├─ 1. Validate request (express-validator)
  ├─ 2. Check SKU uniqueness (DynamoDB GSI: sku-index)
  ├─ 3. PutItem → fanvault-products
  ├─ 4. publishEvent("ProductCreated", { productId, sku, name, category, franchise, stock })
  │       └─ EventBridge.PutEvents → fanvault-event-bus   [fire-and-forget, never blocks]
  ├─ 5. logAuditEvent("PRODUCT_CREATED", ...)
  │       └─ DynamoDB.PutItem → fanvault-audit-logs (TTL: +1 day)  [fire-and-forget]
  └─ 6. HTTP 201 { product }
```

### Image Upload Flow

```
Admin Browser                Commerce Service        S3
  │                               │                   │
  │ GET /api/products/upload-url  │                   │
  │   ?fileType=image/png         │                   │
  │   &fileSize=204800            │                   │
  │   &folder=products            │                   │
  ├──────────────────────────────►│                   │
  │                               │ SSM: fetch bucket │
  │                               │   + CF domain     │
  │                               │ Generate S3 key:  │
  │                               │  products/{uuid}  │
  │                               │ Presigned PUT URL │
  │                               │  (15 min expiry)  │
  │  { uploadUrl, key,            │                   │
  │    cdnUrl, expiresIn: 900 }   │                   │
  │◄──────────────────────────────│                   │
  │                               │                   │
  │ PUT uploadUrl                 │                   │
  │ [binary image data]           │                   │
  ├───────────────────────────────┼──────────────────►│
  │ 200 OK                        │                   │
  │◄──────────────────────────────┼───────────────────│
  │                               │                   │
  │ POST /api/products            │                   │
  │  { images: ["products/uuid"] }│                   │
  ├──────────────────────────────►│                   │
  │                               │ PutItem (DDB)     │
  │ 201 Created { product }       │ publishEvent EB   │
  │◄──────────────────────────────│ logAudit          │
```

### Order Lifecycle

```
POST /api/orders
  │  items[], shippingAddress
  │
  ├─ authenticate (Cognito JWT required)
  ├─ Validate items + address (express-validator)
  ├─ Calculate:
  │    subtotal  = Σ (price × quantity)
  │    shipping  = 0 if subtotal ≥ ₹1,999 else ₹99
  │    tax       = subtotal × 0.18  (18% GST)
  │    total     = subtotal + shipping + tax
  ├─ Generate orderNumber: "FAN-" + 6 random hex chars (uppercase)
  ├─ PutItem → fanvault-orders  (status: "pending")
  ├─ publishEvent("OrderPlaced", { orderId, userId, total, itemCount })
  │       └─ EventBridge [fire-and-forget]
  └─ HTTP 201 { order }

PATCH /api/orders/:id/status (admin)
  │  body: { status }
  │  Valid statuses: pending → processing → shipped → delivered
  │                  Any → cancelled
  ├─ UpdateItem → fanvault-orders
  └─ If status = "cancelled" → publishAlert to SNS (order-failure-alerts) via snsPublisher

POST /api/orders/:id/cancel (user, own orders only)
  ├─ Only cancellable if status = "pending" or "processing"
  └─ UpdateItem → fanvault-orders (status: "cancelled")
```

---

## API Reference

### Products — `/api/products`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/products` | Public | List products (cursor pagination) |
| `GET` | `/api/products/bulk` | Public | Fetch multiple products by IDs |
| `GET` | `/api/products/:productId` | Public | Get single product |
| `GET` | `/api/products/images/:key(*)` | Public | Proxy image from S3 |
| `GET` | `/api/products/upload-url` | Admin | Get presigned S3 PUT URL |
| `POST` | `/api/products` | Admin | Create product |
| `PATCH` | `/api/products/:productId` | Admin | Update product |
| `DELETE` | `/api/products/:productId` | Admin | Soft-delete product |

#### GET /api/products

```
Query params:
  limit        number  (default 20, max ~1000)
  cursor       string  (base64-encoded DynamoDB LastEvaluatedKey from previous page)
  category     string  (clothing | accessories | shoes | ornaments)
  franchise    string  (franchise slug, used with category-franchise-index GSI)
  franchiseType string  (sports | movie | show)

Response 200:
{
  "products": [ {...}, {...} ],
  "cursor": "eyJ...",   // pass as ?cursor= for next page; null when no more pages
  "count": 20
}
```

#### POST /api/products (Admin)

```json
Request body (all required unless noted):
{
  "name":          "CSK Jersey 2024",
  "description":   "Official Chennai Super Kings jersey",
  "price":         1499.00,
  "comparePrice":  1999.00,    // optional — original price for strike-through
  "category":      "clothing", // clothing | accessories | shoes | ornaments
  "franchise":     "chennai-super-kings",
  "franchiseType": "sports",   // sports | movie | show
  "sku":           "CSK-JRS-2024",
  "stock":         150,
  "images":        ["products/uuid1.jpg"]  // S3 keys after upload
}

Response 201: { "message": "Product created", "product": { "productId": "uuid", ...all fields } }
409 → SKU already exists
```

#### GET /api/products/upload-url (Admin)

```
Query params:
  fileType   (image/jpeg | image/png | image/webp | image/gif) — required
  fileSize   number — required, must be ≤ configured limit
  folder     (products | thumbnails | categories) — required

Response 200:
{
  "uploadUrl":  "https://s3.amazonaws.com/bucket/products/uuid.jpg?X-Amz-...",
  "key":        "products/uuid.jpg",
  "cdnUrl":     "https://d1234.cloudfront.net/products/uuid.jpg",
  "expiresIn":  900
}
```

### Orders — `/api/orders`

All routes require `Authorization: Bearer <idToken>`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/orders` | Bearer | Place new order |
| `GET` | `/api/orders/my` | Bearer | My order history |
| `GET` | `/api/orders/:id` | Bearer | Get single order |
| `GET` | `/api/orders` | Admin | List all orders |
| `PATCH` | `/api/orders/:id/status` | Admin | Update order status |
| `POST` | `/api/orders/:id/cancel` | Bearer | Cancel own order |

#### POST /api/orders

```json
Request:
{
  "items": [
    { "productId": "uuid", "name": "CSK Jersey", "price": 1499.00, "quantity": 2 }
  ],
  "shippingAddress": {
    "line1": "Flat 5",
    "city": "Mumbai",
    "state": "Maharashtra",
    "postalCode": "400001",
    "country": "India"
  },
  "paymentMethod": "cod",
  "notes": "Leave at door"
}

Response 201:
{
  "message": "Order placed successfully",
  "order": {
    "orderId":       "uuid",
    "orderNumber":   "FAN-A3F2B1",
    "userId":        "cognito-sub",
    "userEmail":     "user@example.com",
    "items":         [...],
    "shippingAddress": {...},
    "subtotal":      2998.00,
    "shippingCost":  0,          // free (≥ ₹1,999)
    "tax":           539.64,     // 18% GST on subtotal
    "total":         3537.64,
    "paymentMethod": "cod",
    "status":        "pending",
    "createdAt":     "...",
    "updatedAt":     "..."
  }
}
```

### Admin — `/api/admin`

All routes require `Authorization: Bearer <idToken>` + admin role.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/admin/audit-logs` | Admin | Paginated audit logs (1-day TTL) |
| `GET` | `/api/admin/inventory` | Admin | Full inventory list with stock levels |
| `PATCH` | `/api/admin/inventory/:productId` | Admin | Update product stock count |
| `GET` | `/api/admin/metadata/:metaType` | Admin | List categories or franchises |
| `POST` | `/api/admin/metadata/:metaType` | Admin | Create/update category or franchise |
| `DELETE` | `/api/admin/metadata/:metaType/:metaId` | Admin | Deactivate category or franchise |
| `POST` | `/api/admin/generate-metadata` | Admin | AI-generate product metadata from S3 image |

#### POST /api/admin/generate-metadata

Calls `fanvault-ai-service` internally:

```json
Request:  { "imageKey": "products/uuid.jpg" }

Response 200:
{
  "success": true,
  "data": {
    "title":       "CSK Jersey 2024",
    "description": "Official Chennai Super Kings IPL jersey...",
    "category":    "apparel",
    "tags":        ["cricket", "csk", "ipl", "jersey", "sports"]
  },
  "provider":   "bedrock",
  "modelId":    "amazon.nova-pro-v1:0",
  "latencyMs":  2345
}
```

---

## Data Models

### fanvault-products

```
PK: productId (UUID)
Attributes:
  name, description, price (Number), comparePrice (Number?),
  category (clothing|accessories|shoes|ornaments),
  franchise (slug), franchiseType (sports|movie|show),
  sku (unique), stock (Number),
  images (List<String>)   — S3 keys
  thumbnails (List<String>) — populated by Lambda consumer
  isActive (Boolean)      — soft-delete flag (false = deleted)
  createdAt, updatedAt

GSI: sku-index       PK:sku           — unique SKU lookup
GSI: category-franchise-index  PK:category  SK:franchise  — filtered listing
```

### fanvault-orders

```
PK: orderId (UUID)
Attributes:
  orderNumber (FAN-XXXXXX), userId, userEmail,
  items: [{ productId, name, price, quantity, imageKey? }],
  shippingAddress: { line1, line2?, city, state, postalCode, country },
  subtotal, shippingCost (0 or 99), tax (18% GST), total,
  paymentMethod, status (pending|processing|shipped|delivered|cancelled),
  notes?, createdAt, updatedAt

GSI: userId-createdAt-index    PK:userId   SK:createdAt  — user order history
GSI: orderNumber-index         PK:orderNumber             — customer support
GSI: status-createdAt-index    PK:status   SK:createdAt  — admin dashboard
```

### fanvault-audit-logs

```
PK: logId (UUID)
Attributes:
  adminId, adminEmail, action (PRODUCT_CREATED|PRODUCT_UPDATED|PRODUCT_DELETED|
    STOCK_UPDATED|IMAGE_UPLOAD_URL_GENERATED|CATEGORY_UPSERTED|...),
  entityType, entityId,
  changes (Map — old vs new values),
  timestamp, ttlExpiry (Unix epoch, +86400s from creation = 1 day TTL)

GSI: entityType-timestamp-index
GSI: adminId-timestamp-index
```

### fanvault-metadata

```
PK: metaType (category | franchise)
SK: metaId   (slug, e.g. "clothing", "mumbai-indians")
Attributes: displayName, isActive, createdAt, updatedAt
```

---

## Event Publishing

### EventBridge — `fanvault-event-bus`

Published via `src/utils/eventPublisher.js`. All calls are **fire-and-forget** — failures are logged but never block the HTTP response.

| Event | Trigger | Payload |
|---|---|---|
| `ProductCreated` | POST /api/products | `{ productId, sku, name, category, franchise, franchiseType, stock }` |
| `ProductUpdated` | PATCH /api/products/:id | `{ productId, sku, name, category, franchise, franchiseType, stock }` |
| `InventoryLow` | Create/update when stock ≤ 5 | `{ productId, sku, name, stock }` |
| `OrderPlaced` | POST /api/orders | `{ orderId, orderNumber, userId, userEmail, total, itemCount }` |

```javascript
// Example event structure
{
  Source: "fanvault.commerce",
  DetailType: "ProductCreated",
  Detail: JSON.stringify({ productId, sku, name, ... }),
  EventBusName: process.env.EVENTBRIDGE_BUS_NAME || "fanvault-event-bus"
}
```

### SNS — Direct alerts

Published via `src/utils/snsPublisher.js` for order/operational alerts that bypass EventBridge:

```javascript
// Structured alert format
publishAlert({
  topicArn: process.env.SNS_TOPIC_ORDER_FAILURE,
  severity: "HIGH",         // LOW | MEDIUM | HIGH | CRITICAL
  subject:  "Order Failure",
  message:  "...",
  metadata: { orderId, userId }
})
// → SNS Message includes correlationId, timestamp, environment
```

---

## Audit Logging

Every admin action writes to `fanvault-audit-logs` (1-day TTL) via `src/utils/auditLogger.js`. Also fire-and-forget.

Audited actions:
- `PRODUCT_CREATED`, `PRODUCT_UPDATED`, `PRODUCT_DELETED`
- `STOCK_UPDATED`
- `IMAGE_UPLOAD_URL_GENERATED`
- `CATEGORY_UPSERTED`, `CATEGORY_DEACTIVATED`
- `ORDER_STATUS_UPDATED`

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3002` | Server port |
| `NODE_ENV` | `production` | Environment |
| `AWS_REGION` | `us-east-1` | AWS region |
| `COGNITO_REGION` | `us-east-1` | Cognito region |
| `COGNITO_USER_POOL_ID` | — | Cognito pool (e.g. `us-east-1_O7cQQXD1P`) |
| `COGNITO_CLIENT_ID` | — | App client ID |
| `DYNAMODB_TABLE_PRODUCTS` | `fanvault-products` | Products table |
| `DYNAMODB_TABLE_ORDERS` | `fanvault-orders` | Orders table |
| `DYNAMODB_TABLE_AUDIT_LOGS` | `fanvault-audit-logs` | Audit table |
| `DYNAMODB_TABLE_METADATA` | `fanvault-metadata` | Metadata table |
| `EVENTBRIDGE_BUS_NAME` | `fanvault-event-bus` | EventBridge bus (dev: `fanvault-dev-event-bus`) |
| `SNS_TOPIC_ORDER_FAILURE` | — | ARN of order-failure-alerts SNS topic |
| `USE_SECRETS_MANAGER` | `false` | Load secrets from Secrets Manager |
| `SECRET_ID` | — | Secrets Manager secret ID |
| `AI_SERVICE_URL` | `http://ai-service:8000` | AI service URL (internal) |
| `CORS_ORIGIN` | `*` | Allowed CORS origin |

**SSM Parameters** (fetched at runtime via `@aws-sdk/client-ssm`, cached):
- `/fanvault/s3/product-images-bucket` — S3 bucket name
- `/fanvault/cloudfront/domain` — CloudFront domain for image CDN URLs

---

## Source Structure

```
fanvault-commerce-service/
├── src/
│   ├── index.js                     # Express app setup, routes, error handler
│   ├── config/
│   │   └── db.js                    # DynamoDB DocumentClient + initDynamoDB()
│   ├── routes/
│   │   ├── product.routes.js        # Product endpoints
│   │   ├── order.routes.js          # Order endpoints
│   │   └── admin.routes.js          # Admin-only endpoints
│   ├── controllers/
│   │   ├── product.controller.js    # Product CRUD, upload URL, image proxy
│   │   ├── order.controller.js      # Order creation, listing, status updates
│   │   └── admin.controller.js      # Audit, inventory, metadata, AI generate
│   ├── middleware/
│   │   └── auth.middleware.js       # authenticate (JWT decode) + adminOnly
│   ├── models/
│   │   ├── Product.js               # DynamoDB repository for products
│   │   ├── Order.js                 # DynamoDB repository for orders
│   │   ├── AuditLog.js              # DynamoDB repository for audit logs
│   │   └── Metadata.js              # DynamoDB repository for category/franchise
│   └── utils/
│       ├── eventPublisher.js        # EventBridge PutEvents (fire-and-forget)
│       ├── snsPublisher.js          # SNS Publish with structured alert format
│       └── auditLogger.js           # DynamoDB PutItem audit log (fire-and-forget)
└── package.json
```

---

## Health Check

```bash
GET /health
→ { "status": "ok", "service": "fanvault-commerce-service", "database": "dynamodb", "timestamp": "..." }
```

Kubernetes liveness probe: `/health` every 15s (initialDelay 10s).

---

## Running Locally

```bash
cp .env.example .env
# Set: COGNITO_*, DYNAMODB_TABLE_*, EVENTBRIDGE_BUS_NAME, SNS_TOPIC_ORDER_FAILURE

npm install
npm run dev    # nodemon on :3002

# Test product listing
curl http://localhost:3002/api/products
```
