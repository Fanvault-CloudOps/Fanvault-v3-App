#!/usr/bin/env bash
# =============================================================================
# AWS EC2 User Data — FanVault v2 Monolithic App Server
# Target OS: Ubuntu 22.04 LTS (Jammy)
#
# This script provisions both backend services and the frontend assets on the
# same EC2 instance, using Nginx to handle public routing/reverse proxying.
#
# Logs are written to: /var/log/user-data.log
# =============================================================================

# Redirect output to user-data log for debugging
exec > >(tee -i /var/log/user-data.log) 2>&1
set -euo pipefail

# ── 1. Configuration Variables ────────────────────────────────────────────────
# Repository Details
REPO_URL="https://github.com/Fanvault-CloudOps/Fanvault-v3-App.git"
BRANCH="monolithic"

# Database Connection Details (Point to the DB EC2 instance)
DB_HOST="172.31.18.208"
DB_NAME="fanvault_db"
DB_APP_USER="dbuser"
DB_APP_PASSWORD="CHANGE_ME_STRONG_APP_PASSWORD"

# Secrets (Ensure JWT_SECRET matches between services)
# Note: If USE_SECRETS_MANAGER is set to true, these keys can be loaded dynamically from the secret payload.
JWT_SECRET="CHANGE_ME_STRONG_JWT_ACCESS_SECRET"
JWT_REFRESH_SECRET="CHANGE_ME_STRONG_JWT_REFRESH_SECRET"

# AWS Secrets Manager Configuration
USE_SECRETS_MANAGER="true"
AWS_REGION="us-east-1"
SECRET_ID="production/mongodb"

echo "=================================================="
echo " Starting Monolithic App Server Provisioning"
echo "=================================================="

# ── 2. System Dependencies & Node.js ──────────────────────────────────────────
echo "[INFO] Updating package list..."
apt-get update -y

echo "[INFO] Installing system dependencies (Git, Nginx, Rsync, Curl, Netcat, Build essentials)..."
DEBIAN_FRONTEND=noninteractive apt-get install -y git rsync curl netcat-openbsd build-essential nginx

echo "[INFO] Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
echo "[INFO] Node version: $(node -v)"
echo "[INFO] NPM version: $(npm -v)"

# ── 3. Create System User and Directory Structure ─────────────────────────────
echo "[INFO] Creating system user 'fanvault'..."
if ! id "fanvault" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin fanvault
fi

echo "[INFO] Preparing /var/www directory structure..."
mkdir -p /var/www/fanvault-user-service
mkdir -p /var/www/fanvault-commerce-service
mkdir -p /var/www/fanvault-frontend

# ── 4. Clone Codebase to Temporary Directory ──────────────────────────────────
echo "[INFO] Cloning repository ($BRANCH branch)..."
TEMP_BUILD_DIR="/tmp/fanvault-build"
rm -rf "$TEMP_BUILD_DIR"
git clone -b "$BRANCH" "$REPO_URL" "$TEMP_BUILD_DIR"

# ── 5. Setup User Service (Profiles + Addresses) ─────────────────────────────
echo "[INFO] Deploying User Service..."
rsync -av --delete --exclude='.git' --exclude='node_modules' --exclude='deploy' \
  "$TEMP_BUILD_DIR/fanvault-user-service/" "/var/www/fanvault-user-service/"

# Create Environment file
cat > /var/www/fanvault-user-service/.env <<EOF
PORT=3001
NODE_ENV=production
DYNAMODB_TABLE_PROFILES=fanvault-profiles
JWT_SECRET=${JWT_SECRET}
CORS_ORIGIN=*
USE_SECRETS_MANAGER=${USE_SECRETS_MANAGER}
AWS_REGION=${AWS_REGION}
SECRET_ID=${SECRET_ID}
EOF

# Install dependencies
cd /var/www/fanvault-user-service
npm install --omit=dev
chown -R fanvault:fanvault /var/www/fanvault-user-service

# Create and enable systemd service
echo "[INFO] Setting up fanvault-user systemd service..."
cat > /etc/systemd/system/fanvault-user.service <<EOF
[Unit]
Description=FanVault User Service (Profiles & Addresses)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=fanvault
Group=fanvault
WorkingDirectory=/var/www/fanvault-user-service
EnvironmentFile=/var/www/fanvault-user-service/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fanvault-user
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/www/fanvault-user-service

[Install]
WantedBy=multi-user.target
EOF

# ── 6. Setup Commerce Service (Products + Orders) ─────────────────────────────
echo "[INFO] Deploying Commerce Service..."
rsync -av --delete --exclude='.git' --exclude='node_modules' --exclude='deploy' \
  "$TEMP_BUILD_DIR/fanvault-commerce-service/" "/var/www/fanvault-commerce-service/"

# Create Environment file
cat > /var/www/fanvault-commerce-service/.env <<EOF
PORT=3002
NODE_ENV=production
DYNAMODB_TABLE_PRODUCTS=fanvault-products
DYNAMODB_TABLE_ORDERS=fanvault-orders
DYNAMODB_TABLE_METADATA=fanvault-metadata
DYNAMODB_TABLE_AUDIT_LOGS=fanvault-audit-logs
JWT_SECRET=${JWT_SECRET}
CORS_ORIGIN=*
USE_SECRETS_MANAGER=${USE_SECRETS_MANAGER}
AWS_REGION=${AWS_REGION}
SECRET_ID=${SECRET_ID}
EOF

# Install dependencies
cd /var/www/fanvault-commerce-service
npm install --omit=dev
chown -R fanvault:fanvault /var/www/fanvault-commerce-service

# Create and enable systemd service
echo "[INFO] Setting up fanvault-commerce systemd service..."
cat > /etc/systemd/system/fanvault-commerce.service <<EOF
[Unit]
Description=FanVault Commerce Service (Products + Orders)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=fanvault
Group=fanvault
WorkingDirectory=/var/www/fanvault-commerce-service
EnvironmentFile=/var/www/fanvault-commerce-service/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fanvault-commerce
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/www/fanvault-commerce-service

[Install]
WantedBy=multi-user.target
EOF

# ── 7. Enable and Start Backend Services ──────────────────────────────────────
echo "[INFO] Starting systemd services..."
systemctl daemon-reload
systemctl enable fanvault-user fanvault-commerce
systemctl start fanvault-user fanvault-commerce

# ── 8. Build & Deploy Frontend (Nginx + React Static) ──────────────────────────
echo "[INFO] Building frontend React SPA..."
cd "$TEMP_BUILD_DIR/fanvault-frontend"

# Write Vite environment variable (build time)
cat > .env <<EOF
VITE_APP_NAME=FanVault
EOF

# Install and build
npm install
npm run build

# Copy build to production directory
echo "[INFO] Copying built static assets to Nginx root..."
mkdir -p /var/www/fanvault-frontend/dist
rsync -av --delete ./dist/ /var/www/fanvault-frontend/dist/
chown -R www-data:www-data /var/www/fanvault-frontend

# Install modified Nginx site configuration
echo "[INFO] Installing Nginx configuration..."
cp ./nginx.conf /etc/nginx/sites-available/fanvault

# Remove default configuration and enable site
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/fanvault /etc/nginx/sites-enabled/fanvault

# Restart Nginx
systemctl enable nginx
systemctl restart nginx

# ── 9. Seed DynamoDB Database ────────────────────────────────────────────────
echo "[INFO] Bootstrapping and seeding DynamoDB..."
cd "$TEMP_BUILD_DIR/shared-resources/database"
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb bcryptjs uuid dotenv
export AWS_REGION="${AWS_REGION}"
node bootstrap-dynamodb.js

# ── 10. Verification ─────────────────────────────────────────────────────────
echo "[INFO] Verifying local services..."
sleep 3
systemctl status fanvault-user --no-pager
systemctl status fanvault-commerce --no-pager
nginx -t

echo "=================================================="
echo " Monolithic Server Provisioning Completed!"
echo " Logs written to /var/log/user-data.log"
echo "=================================================="
