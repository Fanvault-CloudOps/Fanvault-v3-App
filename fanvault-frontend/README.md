# fanvault-frontend

React 18 SPA for FanVault — customer shop, cart, checkout, user profile, and admin portal. Served by Nginx as static files with an API proxy to backend services.

- **Port:** `80` (Nginx)
- **Build:** Vite 6
- **Runtime:** React 18, React Router v6
- **API:** Axios with automatic token refresh interceptor

---

## Application Routes

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  FanVault Frontend — Page Map                                                │
└──────────────────────────────────────────────────────────────────────────────┘

Public (no auth required)
─────────────────────────────────────────────────
  /                   HomePage        Product showcase, hero banner
  /products           ProductsPage    Filterable product catalog with pagination
  /products/:id       ProductDetailPage  Product detail + add to cart
  /cart               CartPage        Cart review + proceed to checkout
  /register           RegisterPage    Create Cognito account
  /confirm-email      ConfirmEmailPage  Enter Cognito confirmation code
  /login              LoginPage       Sign in (redirects to /products if already authenticated)

Guest-only (redirect → /products if authenticated)
─────────────────────────────────────────────────
  /login              GuestRoute → LoginPage
  /register           GuestRoute → RegisterPage

Protected (redirect → /login if not authenticated)
─────────────────────────────────────────────────
  /checkout           CheckoutPage    Shipping address + order placement
  /orders             OrdersPage      User's order history
  /orders/:id         OrderDetailPage Single order view + cancel
  /profile            ProfilePage     Edit profile + manage addresses

Admin Portal (redirect → / if not admin role)
─────────────────────────────────────────────────
  /admin              AdminDashboard   Summary stats and quick links
  /admin/products     AdminProducts    Product listing + delete
  /admin/products/new AdminProductForm Create product (with S3 upload + AI metadata)
  /admin/products/:id AdminProductForm Edit product
  /admin/orders       AdminOrders      All orders + status management
  /admin/inventory    AdminInventory   Stock levels + quick update
  /admin/categories   AdminCategories  Category + franchise management
  /admin/audit        AdminAudit       Audit log viewer (1-day retention)
```

---

## Component & Context Architecture

```
main.jsx
  └── <AuthProvider>        ← AuthContext: user, profile, login(), register(), logout()
        └── <CartProvider>  ← CartContext: items[], addItem(), removeItem(), total, count
              └── <RouterProvider>
                    └── <Navbar>          always visible
                    └── <Outlet>          renders active page
                    └── <Footer>          always visible
```

### AuthContext

Manages Cognito session state stored in `localStorage`:

| Key | Content |
|---|---|
| `accessToken` | Cognito AccessToken — sent as `Authorization: Bearer` on all API calls |
| `refreshToken` | Cognito RefreshToken — used by Axios interceptor to auto-rotate |
| `user` | `{ id, email, groups, role }` serialized JSON |

**Auto-refresh:** The Axios response interceptor catches `401` responses, calls `POST /api/auth/refresh`, and retries the original request with the new token. If refresh fails, clears `localStorage` and redirects to `/login`.

**Post-login profile creation:** After successful login, `login()` calls `POST /api/users/me` to ensure a DynamoDB profile exists for the user (idempotent — 409 if already exists).

### CartContext

Cart state is persisted to `localStorage` under `cart` (JSON array). It is never sent to the backend until the user places an order.

```
CartItem: {
  productId, name, price, image,
  franchise, size, color, quantity
}

Cart key: `${productId}-${size}-${color}`   (allows same product in different sizes)
```

---

## API Client

`src/api/client.js` exports a configured Axios instance + domain-grouped API functions:

```
authAPI   — register, confirm, resendCode, login, logout, verify
userAPI   — getProfile, createProfile, updateProfile, addAddress, removeAddress
productAPI — getProducts, getProduct, createProduct, updateProduct, deleteProduct
orderAPI  — createOrder, getMyOrders, getOrder, cancelOrder, getAllOrders, updateOrderStatus
adminAPI  — getAuditLogs, getInventory, updateStock, getMetadata, upsertMetadata,
            deleteMetadata, getUploadUrl, createProduct, updateProduct, deleteProduct,
            getProducts, getProduct, generateMetadata, getAllOrders, updateOrderStatus
```

All calls use `baseURL: ''` — the full path (e.g. `/api/products`) is passed to Nginx, which proxies to the appropriate backend service.

---

## Admin: Product Creation with AI Metadata

```
AdminProductForm  (admin-only)
  │
  │  1. Admin uploads image:
  │       GET /api/products/upload-url?fileType=image/jpeg&fileSize=...&folder=products
  │       ← { uploadUrl, key, cdnUrl }
  │       PUT uploadUrl (direct browser → S3, no backend intermediary)
  │
  │  2. Admin clicks "Generate Metadata":
  │       POST /api/admin/generate-metadata { imageKey: "products/uuid.jpg" }
  │       ← { data: { title, description, category, tags }, latencyMs }
  │       Auto-fills form fields from AI response
  │
  │  3. Admin reviews/edits and saves:
  │       POST /api/products { name, description, price, category, franchise,
  │                            franchiseType, sku, stock, images: ["products/uuid.jpg"] }
  │       ← { product: { productId, ... } }
```

---

## Nginx Configuration

In the EC2 (non-Kubernetes) deployment, Nginx serves the React build and proxies API calls locally:

```nginx
server {
  listen 80;

  # React SPA — all non-API paths return index.html (client-side routing)
  root /var/www/fanvault-frontend/dist;
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Proxy /api/auth/* and /api/users/* → Identity Service :3001
  location /api/auth/ {
    proxy_pass http://localhost:3001;
  }
  location /api/users/ {
    proxy_pass http://localhost:3001;
  }

  # Proxy /api/products/* /api/orders/* /api/admin/* → Commerce Service :3002
  location /api/products/ { proxy_pass http://localhost:3002; }
  location /api/orders/   { proxy_pass http://localhost:3002; }
  location /api/admin/    { proxy_pass http://localhost:3002; }
}
```

**In Kubernetes:** the API proxy is handled by the Kubernetes Gateway API (`HTTPRoute`) at the cluster level. The Nginx container only serves static files — the backend proxy config is templated from `config.USER_SERVICE_HOST`, `config.COMMERCE_SERVICE_HOST` in the Helm chart.

---

## Pages Reference

### Public

| Page | Description |
|---|---|
| `HomePage` | Hero banner, featured products carousel, franchise categories |
| `ProductsPage` | Product grid with filter by category/franchise/price, cursor pagination, search |
| `ProductDetailPage` | Full product info, image gallery, size/color selectors, add to cart |
| `CartPage` | Cart items, quantity editor, subtotal, shipping + tax preview |
| `LoginPage` | Email + password form, Cognito errors mapped to user-friendly messages |
| `RegisterPage` | Name + email + password form, redirects to `/confirm-email` after success |
| `ConfirmEmailPage` | Cognito verification code entry form |

### Protected (logged-in)

| Page | Description |
|---|---|
| `CheckoutPage` | Address picker/create, order summary with 18% GST + shipping calc, place order |
| `OrdersPage` | Paginated order history list |
| `OrderDetailPage` | Order detail: items, totals, status badge, cancel button (if pending/processing) |
| `ProfilePage` | Edit first/last name, phone, preferences; add/remove shipping addresses |

### Admin

| Page | Description |
|---|---|
| `AdminLayout` | Side-nav wrapper for all admin pages |
| `AdminDashboard` | Stats overview |
| `AdminProducts` | Product table, search, delete (soft) |
| `AdminProductForm` | Create/edit product — image upload → S3, AI metadata generation, form validation |
| `AdminOrders` | All orders, status filter, status update |
| `AdminInventory` | Product list with stock counts, inline quick update |
| `AdminCategories` | Manage categories and franchises (upsert, deactivate) |
| `AdminAudit` | Paginated audit log viewer with entity-type + admin filters |

---

## Frontend Architecture Diagram

```
Browser
  │
  │  HTTPS → CloudFront → ALB → Nginx :80 (Frontend EC2)
  │
  ├── React Router v6 (client-side routing)
  │     ├── Public routes
  │     ├── Protected routes  (ProtectedRoute: checks AuthContext.user)
  │     ├── Guest routes      (GuestRoute: redirects if logged in)
  │     └── Admin routes      (AdminRoute: checks user.role === "admin")
  │
  ├── AuthContext (React Context + localStorage)
  │     ├── Cognito tokens: accessToken, refreshToken
  │     ├── User: { id, email, groups, role }
  │     └── Profile: DynamoDB fanvault-profiles record
  │
  ├── CartContext (React Context + localStorage)
  │     └── items[], count, total
  │
  ├── Axios (api/client.js)
  │     ├── Interceptor: inject Authorization Bearer header
  │     └── Interceptor: 401 → auto-refresh → retry
  │
  └── Nginx (static file server)
        ├── try_files → /index.html (SPA fallback)
        ├── /api/auth/, /api/users/ → proxy :3001
        └── /api/products/, /api/orders/, /api/admin/ → proxy :3002
```

---

## Environment Variables (Helm ConfigMap)

In Kubernetes, the frontend Nginx config is templated with:

| Variable | Dev Value | Description |
|---|---|---|
| `USER_SERVICE_HOST` | `dev-user-service` | Internal hostname of user-service |
| `USER_SERVICE_PORT` | `3001` | User service port |
| `COMMERCE_SERVICE_HOST` | `dev-commerce-service` | Internal hostname of commerce-service |
| `COMMERCE_SERVICE_PORT` | `3002` | Commerce service port |

No secrets are needed for the frontend — all auth is handled client-side with Cognito tokens.

---

## Tech Stack

| Library | Version | Purpose |
|---|---|---|
| `react` | 18.3.1 | UI framework |
| `react-dom` | 18.3.1 | DOM rendering |
| `react-router-dom` | 6.30.4 | Client-side routing |
| `axios` | 1.16.0 | HTTP client + interceptors |
| `react-hot-toast` | 2.4.1 | Toast notifications |
| `lucide-react` | 0.344.0 | Icon library |
| `vite` | 6.4.2 | Build tool + dev server |
| `@vitejs/plugin-react` | 4.2.1 | React fast refresh in Vite |

---

## Building

```bash
npm install
npm run dev      # Vite dev server on :5173 (hot reload)
npm run build    # Production build → dist/
npm run preview  # Preview production build locally
```

**Production build** outputs to `dist/` — served by Nginx with `root /var/www/fanvault-frontend/dist`.

---

## Kubernetes Resources

Deployed via Helm chart `charts/frontend` in [Fanvault-GitOps](../../Fanvault-GitOps/).

| Resource | Value |
|---|---|
| Container port | `8080` (Nginx non-root) |
| Service port | `80` |
| Pod user | `101` (nginx) |
| Extra volumes | `tmp` → `/tmp`, `nginx-cache` → `/var/cache/nginx` |
| HPA min / max | 2 / 3 (dev), 2 / 5 (prod) |
| CPU request / limit | 100m / 500m |
| Memory request / limit | 128Mi / 512Mi |
| Network policy | Only kgateway pods can send traffic in |
