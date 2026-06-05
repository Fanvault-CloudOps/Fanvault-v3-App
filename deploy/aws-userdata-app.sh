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
REPO_URL="https://github.com/Savitxr/Fanvault-Mono.git"
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
mkdir -p /var/www/fanvault-user-auth-service
mkdir -p /var/www/fanvault-commerce-service
mkdir -p /var/www/fanvault-frontend

# ── 4. Clone Codebase to Temporary Directory ──────────────────────────────────
echo "[INFO] Cloning repository ($BRANCH branch)..."
TEMP_BUILD_DIR="/tmp/fanvault-build"
rm -rf "$TEMP_BUILD_DIR"
git clone -b "$BRANCH" "$REPO_URL" "$TEMP_BUILD_DIR"

# ── 5. Setup Identity Service (Auth + User Profiles) ─────────────────────────
echo "[INFO] Deploying Identity Service..."
rsync -av --delete --exclude='.git' --exclude='node_modules' --exclude='deploy' \
  "$TEMP_BUILD_DIR/fanvault-user-auth-service/" "/var/www/fanvault-user-auth-service/"

# Create Environment file
cat > /var/www/fanvault-user-auth-service/.env <<EOF
PORT=3001
NODE_ENV=production
MONGO_URI=mongodb://${DB_APP_USER}:${DB_APP_PASSWORD}@${DB_HOST}:27017/${DB_NAME}?authSource=${DB_NAME}
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=15m
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
JWT_REFRESH_EXPIRES_IN=7d
CORS_ORIGIN=*
USE_SECRETS_MANAGER=${USE_SECRETS_MANAGER}
AWS_REGION=${AWS_REGION}
SECRET_ID=${SECRET_ID}
EOF

# Install dependencies
cd /var/www/fanvault-user-auth-service
npm install --omit=dev
chown -R fanvault:fanvault /var/www/fanvault-user-auth-service

# Create and enable systemd service
echo "[INFO] Setting up fanvault-auth systemd service..."
cat > /etc/systemd/system/fanvault-auth.service <<EOF
[Unit]
Description=FanVault Identity Service (Auth + User Profiles)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=fanvault
Group=fanvault
WorkingDirectory=/var/www/fanvault-user-auth-service
EnvironmentFile=/var/www/fanvault-user-auth-service/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fanvault-auth
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/www/fanvault-user-auth-service

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
MONGO_URI=mongodb://${DB_APP_USER}:${DB_APP_PASSWORD}@${DB_HOST}:27017/${DB_NAME}?authSource=${DB_NAME}
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
systemctl enable fanvault-auth fanvault-commerce
systemctl start fanvault-auth fanvault-commerce

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

# ── 9. Seed Consolidated Database ─────────────────────────────────────────────
echo "[INFO] Waiting for database to be reachable..."

RESOLVED_DB_HOST="$DB_HOST"
if [ "$USE_SECRETS_MANAGER" = "true" ]; then
  echo "[INFO] USE_SECRETS_MANAGER is true. Resolving database host from Secrets Manager..."
  # Install SDK temporarily to resolve the host
  mkdir -p /tmp/resolve-db
  cd /tmp/resolve-db
  npm install @aws-sdk/client-secrets-manager > /dev/null 2>&1
  
  RESOLVED_DB_HOST=$(node -e "
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({ region: '${AWS_REGION}' });
    client.send(new GetSecretValueCommand({ SecretId: '${SECRET_ID}' }))
      .then(res => {
        const secret = JSON.parse(res.SecretString);
        console.log(secret.host);
        process.exit(0);
      })
      .catch(err => {
        console.error(err);
        process.exit(1);
      });
  " 2>/dev/null || echo "$DB_HOST")
fi

echo "[INFO] Target database host resolved to: $RESOLVED_DB_HOST"

until nc -z -w5 "$RESOLVED_DB_HOST" 27017; do
  echo "Waiting for database port 27017 on $RESOLVED_DB_HOST to open..."
  sleep 3
done

echo "[INFO] Database port is open. Seeding database..."
cd "$TEMP_BUILD_DIR/shared-resources/database"
npm install mongoose bcryptjs dotenv @aws-sdk/client-secrets-manager
export MONGO_URI="mongodb://${DB_APP_USER}:${DB_APP_PASSWORD}@${DB_HOST}:27017/${DB_NAME}?authSource=${DB_NAME}"
export USE_SECRETS_MANAGER="${USE_SECRETS_MANAGER}"
export AWS_REGION="${AWS_REGION}"
export SECRET_ID="${SECRET_ID}"
node seed-data.js

# ── 10. Verification ─────────────────────────────────────────────────────────
echo "[INFO] Verifying local services..."
sleep 3
systemctl status fanvault-auth --no-pager
systemctl status fanvault-commerce --no-pager
nginx -t

echo "=================================================="
echo " Monolithic Server Provisioning Completed!"
echo " Logs written to /var/log/user-data.log"
echo "=================================================="
