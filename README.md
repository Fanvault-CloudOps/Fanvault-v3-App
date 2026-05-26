# FanVault v2 — Monorepo

Consolidated 3-microservice architecture extracted from the original FanVault 6-service ecosystem.

## Services

| Directory | Purpose | Port |
|---|---|---|
| `fanvault-frontend/` | React/Vite SPA + Nginx reverse proxy | 80 |
| `fanvault-user-auth-service/` | Authentication + User profiles | 3001 |
| `fanvault-commerce-service/` | Product catalog + Order management | 3002 |

## Key Design Decisions

- **No inter-service REST calls** — Auth and User merged; Commerce self-validates JWTs using the shared `JWT_SECRET`
- **Single MongoDB database** (`fanvault_db`) with 4 collections across 2 services
- **Email service removed** — order events are logged locally
- **Private DNS** via Route53 Private Hosted Zone (`fanvault.internal`) — no `.local`, no hardcoded IPs
- **Traditional EC2 deployment** — systemd + Nginx, no containers, no Kubernetes
## Target Architecture
<img width="3075" height="3263" alt="architecture png" src="https://github.com/user-attachments/assets/3fbbf997-773c-4d25-903a-7ec511e4112f" />
## Quick Start (Local Development)

```bash
# Identity Service
cd fanvault-user-auth-service
cp .env.example .env   # fill in MONGO_URI, JWT_SECRET, JWT_REFRESH_SECRET
npm install
npm run dev            # starts on :3001

# Commerce Service (separate terminal)
cd fanvault-commerce-service
cp .env.example .env   # fill in MONGO_URI, JWT_SECRET (must match auth service)
npm install
npm run dev            # starts on :3002

# Frontend (separate terminal)
cd fanvault-frontend
npm install
npm run dev            # Vite dev server, proxies /api/* to localhost:3001 / :3002
```

## Deployment Order (AWS EC2)

1. MongoDB EC2 (DB subnet) → run `shared-resources/database/seed-data.js`
2. Identity Service EC2 (Backend subnet) → run `fanvault-user-auth-service/deploy/deploy.sh`
3. Commerce Service EC2 (Backend subnet) → run `fanvault-commerce-service/deploy/deploy.sh`
4. Frontend EC2 (Frontend subnet) → `npm run build` then `fanvault-frontend/deploy/setup-nginx.sh`
5. Register Frontend EC2 to ALB target group → validate via `/health`

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full diagrams, security groups, DNS strategy, and environment variable matrix.

## Shared Resources

```
shared-resources/
├── database/seed-data.js          # Populates all 4 collections
├── healthcheck/healthcheck.sh     # Validates both backend services
└── nginx/alb-listener.conf        # ALB target group and listener setup
```
