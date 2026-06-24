# fanvault-user-service

Identity and profile management service for FanVault v3. Handles registration, authentication via **AWS Cognito**, email confirmation, and user profile + shipping address management backed by **DynamoDB**.

- **Port:** `3001`
- **Runtime:** Node.js ≥ 18, Express 4
- **Auth provider:** AWS Cognito (User Pool + App Client)
- **Database:** DynamoDB (`fanvault-profiles` table)

---

## How It Works

```
┌───────────────────────────────────────────────────────────────────────────┐
│  fanvault-user-service  — Auth & Profile Flow                             │
└───────────────────────────────────────────────────────────────────────────┘

  Client
    │
    │  POST /api/auth/register
    │  { email, password, firstName, lastName }
    ▼
  ┌──────────────────────────────────────────────────────┐
  │  Cognito.SignUpCommand                               │
  │  Creates user in pool with email/given_name/         │
  │  family_name attributes                             │
  │  → Cognito sends email verification code            │
  └──────────────────────────────────────────────────────┘

    │  POST /api/auth/confirm
    │  { email, code }
    ▼
  ┌──────────────────────────────────────────────────────┐
  │  Cognito.ConfirmSignUpCommand                        │
  │  Verifies code → account becomes CONFIRMED           │
  └──────────────────────────────────────────────────────┘

    │  POST /api/auth/login
    │  { email, password }
    ▼
  ┌──────────────────────────────────────────────────────┐
  │  Cognito.InitiateAuthCommand (USER_PASSWORD_AUTH)    │
  │  Returns: AccessToken, IdToken, RefreshToken         │
  │  Admin role detected from cognito:groups = "admins" │
  └──────────────────────────────────────────────────────┘
    │
    │  Response → { accessToken, idToken, refreshToken,
    │               expiresIn, user: { id, email, groups, role } }
    │
    ▼  (subsequent requests)

  Protected Endpoint (Bearer IdToken in Authorization header)
    │
    │  authenticate middleware:
    │  1. Extract Bearer token from header
    │  2. If JWT_SECRET set → jwt.verify(); fallback to jwt.decode()
    │     In production: kgateway validates Cognito JWT signature
    │  3. Map Cognito claims → req.user { id, sub, email, groups, role }
    │
    │  adminOnly middleware:
    │     Checks cognito:groups.includes("admins")
    ▼

  Profile Operations (DynamoDB fanvault-profiles)
    │  GET  /api/users/me         → UserProfileRepository.findByUserId
    │  POST /api/users/me         → UserProfileRepository.create
    │  PATCH /api/users/me        → UserProfileRepository.update
    │  POST /api/users/me/addresses    → addAddress (read-modify-write)
    │  DELETE /api/users/me/addresses/:id → removeAddress (filter)
    ▼

  Startup:
    initDynamoDB() → describe fanvault-profiles table
    app.listen(3001)
```

---

## Authentication Flow

```
Registration & Confirmation
─────────────────────────────────────────────────────────────────
 1. POST /api/auth/register     → Cognito.SignUpCommand
                                  ↳ email verification sent
 2. POST /api/auth/confirm       → Cognito.ConfirmSignUpCommand
                                  ↳ account CONFIRMED
 3. (optional) POST /api/auth/resend-code → Cognito.ResendConfirmationCodeCommand

Login & Session
─────────────────────────────────────────────────────────────────
 4. POST /api/auth/login         → Cognito.InitiateAuthCommand (USER_PASSWORD_AUTH)
                                  ← accessToken (API calls)
                                  ← idToken (profile, groups, sub claim)
                                  ← refreshToken (rotate tokens)
                                  ← expiresIn (seconds, typically 3600)

 5. POST /api/auth/refresh       → Cognito.InitiateAuthCommand (REFRESH_TOKEN_AUTH)
                                  ← new accessToken + idToken

Token Validation (per-request)
─────────────────────────────────────────────────────────────────
 6. authenticate middleware decodes the IdToken:
      sub        → req.user.id (Cognito user UUID)
      email      → req.user.email
      cognito:groups → req.user.groups
      "admins" in groups → req.user.role = "admin"

 Note: In Kubernetes (kgateway), JWT signature is validated at the
       gateway layer before reaching the service. The service only
       decodes the already-validated token payload.

Logout
─────────────────────────────────────────────────────────────────
 7. POST /api/auth/logout        → Cognito.GlobalSignOutCommand
                                  Invalidates ALL sessions for the user

Token Verification (lightweight)
─────────────────────────────────────────────────────────────────
 8. GET /api/auth/verify         → local jwt.decode() only (no Cognito round-trip)
                                  ← { id, email, groups }
```

---

## API Reference

### Auth Routes — `/api/auth`

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | Public | Register new user in Cognito |
| `POST` | `/api/auth/confirm` | Public | Confirm email with Cognito code |
| `POST` | `/api/auth/resend-code` | Public | Resend Cognito confirmation code |
| `POST` | `/api/auth/login` | Public | Login; returns Cognito tokens |
| `POST` | `/api/auth/refresh` | Public | Refresh access/id tokens |
| `GET` | `/api/auth/verify` | Bearer | Decode token, return user claims |
| `POST` | `/api/auth/logout` | Bearer | GlobalSignOut all Cognito sessions |

#### POST /api/auth/register

```json
Request:
{ "email": "user@example.com", "password": "Secure123!", "firstName": "Sachin", "lastName": "Tendulkar" }

Response 201:
{ "message": "Registration successful. Please verify your email." }

Errors:
  409 → UsernameExistsException
  400 → validation failure (missing fields, weak password)
```

#### POST /api/auth/confirm

```json
Request:  { "email": "user@example.com", "code": "123456" }
Response: { "message": "Email confirmed. You can now sign in." }
Errors:   400 → CodeMismatchException | ExpiredCodeException
```

#### POST /api/auth/login

```json
Request:
{ "email": "user@example.com", "password": "Secure123!" }

Response 200:
{
  "accessToken":  "eyJ...",    // Cognito AccessToken — use for API calls
  "idToken":      "eyJ...",    // Cognito IdToken — contains sub, email, groups
  "refreshToken": "eyJ...",    // Use for /refresh
  "expiresIn":    3600,
  "user": {
    "id":     "b92f...",       // Cognito sub (UUID)
    "email":  "user@example.com",
    "groups": [],              // Cognito group names
    "role":   "user"           // "admin" if groups includes "admins"
  }
}

Errors:
  401 → NotAuthorizedException (wrong password)
  403 → UserNotConfirmedException (email not verified)
  400 → other Cognito errors
```

#### POST /api/auth/refresh

```json
Request:  { "refreshToken": "eyJ..." }
Response: { "accessToken": "eyJ...", "idToken": "eyJ...", "expiresIn": 3600 }
Errors:   401 → expired/invalid refresh token
```

#### GET /api/auth/verify

```
Header: Authorization: Bearer <idToken>
Response: { "id": "b92f...", "email": "user@example.com", "groups": [] }
```

#### POST /api/auth/logout

```
Header: Authorization: Bearer <accessToken>
Response: { "message": "Logged out successfully" }
```

---

### User Profile Routes — `/api/users`

All routes require `Authorization: Bearer <idToken>`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/users/me` | Bearer | Get my profile |
| `POST` | `/api/users/me` | Bearer | Create profile (after registration) |
| `PATCH` | `/api/users/me` | Bearer | Update profile fields |
| `POST` | `/api/users/me/addresses` | Bearer | Add shipping address |
| `DELETE` | `/api/users/me/addresses/:addressId` | Bearer | Remove shipping address |

#### GET /api/users/me

```json
Response 200:
{
  "userId":    "b92f-...",
  "email":     "user@example.com",
  "firstName": "Sachin",
  "lastName":  "Tendulkar",
  "phone":     null,
  "avatar":    null,
  "addresses": [
    {
      "addressId": "uuid",
      "line1": "Flat 5, Cricket Lane",
      "line2": null,
      "city": "Mumbai",
      "state": "Maharashtra",
      "postalCode": "400001",
      "country": "India",
      "isDefault": true
    }
  ],
  "preferences": { "newsletter": true, "smsAlerts": false },
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}

404 → profile not found (user registered but hasn't created profile)
```

#### POST /api/users/me (Create Profile)

```json
Request:
{
  "email":     "user@example.com",  // isEmail(), normalizeEmail
  "firstName": "Sachin",             // optional, max 50 chars
  "lastName":  "Tendulkar"           // optional, max 50 chars
}

Response 201: { "message": "Profile created", "profile": {...} }
409 → profile already exists (ConditionExpression: attribute_not_exists(userId))
```

#### PATCH /api/users/me

```json
Request (all fields optional):
{
  "firstName":   "Sachin",
  "lastName":    "Tendulkar",
  "phone":       "+91-9876543210",
  "preferences": { "newsletter": false, "smsAlerts": true }
}

Response: { "message": "Profile updated", "profile": {...} }
```

#### POST /api/users/me/addresses

```json
Request:
{
  "line1":      "Flat 5, Cricket Lane",  // required
  "line2":      "Near Stadium",          // optional
  "city":       "Mumbai",                // required
  "state":      "Maharashtra",           // required
  "postalCode": "400001",                // required
  "country":    "India",                 // required
  "isDefault":  true                     // if true, clears isDefault on all other addresses
}

Response: { "message": "Address added", "profile": {...} }
```

#### DELETE /api/users/me/addresses/:addressId

```
Response: { "message": "Address removed", "profile": {...} }
```

---

## Data Model

### DynamoDB: `fanvault-profiles`

```
Table: fanvault-profiles (or fanvault-dev-profiles in dev)
Billing: PAY_PER_REQUEST
Encryption: KMS
PITR: Enabled

PK: userId (String)  ← Cognito sub (UUID from idToken.sub)

Attributes:
  userId      (String)  PK — Cognito sub
  email       (String)  lowercase, trimmed
  firstName   (String | null)
  lastName    (String | null)
  phone       (String | null)
  avatar      (String | null)  S3 key (future)
  addresses   (List)    Each item: { addressId, line1, line2?, city, state,
                                     postalCode, country, isDefault }
  preferences (Map)     { newsletter: Boolean, smsAlerts: Boolean }
  createdAt   (String)  ISO 8601
  updatedAt   (String)  ISO 8601
```

**Note:** There is no separate `users` table in the user-service. User identity (email, password, confirmation status) is managed exclusively by Cognito. The `fanvault-profiles` table stores only the application-level profile data (display name, addresses, preferences).

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server port |
| `NODE_ENV` | `production` | Environment |
| `AWS_REGION` | `us-east-1` | AWS region |
| `COGNITO_REGION` | `us-east-1` | Cognito region |
| `COGNITO_USER_POOL_ID` | — | Cognito User Pool ID (e.g. `us-east-1_O7cQQXD1P`) |
| `COGNITO_CLIENT_ID` | — | App Client ID (e.g. `3fioa78u18rkf7c3kiqb3sud55`) |
| `DYNAMODB_TABLE_PROFILES` | `fanvault-profiles` | DynamoDB table name |
| `USE_SECRETS_MANAGER` | `false` | Load config from Secrets Manager |
| `SECRET_ID` | — | Secrets Manager secret ID (if enabled) |
| `CORS_ORIGIN` | `*` | Allowed CORS origin |
| `JWT_SECRET` | — | Optional; only used for local dev JWT verification |

**Production (Kubernetes):** All env vars injected via ConfigMap + Secrets Manager (if `USE_SECRETS_MANAGER=true`). IRSA role `fanvault-user-irsa-role` grants DynamoDB and Secrets Manager access.

---

## Source Structure

```
fanvault-user-service/
├── src/
│   ├── index.js                 # Express app: helmet, cors, morgan, routes, error handler
│   ├── config/
│   │   └── db.js                # DynamoDB DocumentClient singleton + initDynamoDB()
│   ├── routes/
│   │   ├── auth.routes.js       # All Cognito auth operations
│   │   └── user.routes.js       # Profile CRUD + address management
│   ├── controllers/
│   │   └── user.controller.js   # getProfile, createProfile, updateProfile, addAddress, removeAddress
│   ├── middleware/
│   │   └── auth.middleware.js   # authenticate (JWT decode) + adminOnly (Cognito groups)
│   └── models/
│       └── UserProfile.js       # DynamoDB repository: findByUserId, create, update, addAddress, removeAddress
└── package.json
```

---

## Health Check

```bash
GET /health
→ {
    "status":    "ok",
    "service":   "fanvault-user-service",
    "database":  "dynamodb",
    "timestamp": "2026-06-24T00:00:00.000Z"
  }
```

Kubernetes liveness probe hits `/health` every 15s (initialDelay 10s).

---

## Running Locally

```bash
# Prerequisites: AWS credentials with Cognito + DynamoDB access
cp .env.example .env

# Minimum required env vars:
# COGNITO_USER_POOL_ID=us-east-1_O7cQQXD1P
# COGNITO_CLIENT_ID=3fioa78u18rkf7c3kiqb3sud55
# DYNAMODB_TABLE_PROFILES=fanvault-dev-profiles
# AWS_REGION=us-east-1

npm install
npm run dev    # nodemon — restarts on file changes

# Test registration
curl -X POST http://localhost:3001/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"Test1234!","firstName":"Test","lastName":"User"}'
```
