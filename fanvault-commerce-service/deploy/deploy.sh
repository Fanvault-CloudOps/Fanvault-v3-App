#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Commerce Service (fanvault-commerce-service)
# Run as root or sudo on the target EC2 backend instance.
# =============================================================================
set -euo pipefail

SERVICE_NAME="fanvault-commerce"
APP_DIR="/var/www/fanvault-commerce-service"
SERVICE_FILE="./deploy/fanvault-commerce.service"
SYSTEMD_DIR="/etc/systemd/system"
NODE_VERSION="18"

echo "=============================================="
echo " FanVault Commerce Service — Deployment Script"
echo "=============================================="

# ── 1. Ensure Node.js is installed ───────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[INFO] Installing Node.js ${NODE_VERSION}..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y nodejs
else
  echo "[INFO] Node.js found: $(node --version)"
fi

# ── 2. Create dedicated system user ──────────────────────────────────────────
if ! id "fanvault" &>/dev/null; then
  echo "[INFO] Creating fanvault system user..."
  useradd --system --no-create-home --shell /usr/sbin/nologin fanvault
fi

# ── 3. Create app directory and copy code ────────────────────────────────────
echo "[INFO] Deploying application code to ${APP_DIR}..."
mkdir -p "${APP_DIR}"
rsync -av --exclude='.git' --exclude='node_modules' --exclude='deploy' \
  ./ "${APP_DIR}/"

# ── 4. Verify .env file exists ───────────────────────────────────────────────
if [ ! -f "${APP_DIR}/.env" ]; then
  echo "[ERROR] .env file not found at ${APP_DIR}/.env"
  echo "        Copy .env.example to ${APP_DIR}/.env and fill in all values."
  exit 1
fi

# ── 5. Install production dependencies ───────────────────────────────────────
echo "[INFO] Installing npm dependencies..."
cd "${APP_DIR}"
npm install --omit=dev

# ── 6. Set correct ownership ─────────────────────────────────────────────────
chown -R fanvault:fanvault "${APP_DIR}"

# ── 7. Install and enable systemd service ────────────────────────────────────
echo "[INFO] Installing systemd service..."
cp "${OLDPWD}/${SERVICE_FILE}" "${SYSTEMD_DIR}/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

# ── 8. Validate service is running ───────────────────────────────────────────
sleep 3
if systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo "[OK] ${SERVICE_NAME} is running."
  echo "[OK] Health check:"
  curl -sf http://localhost:3002/health || echo "[WARN] Health endpoint not responding yet."
else
  echo "[ERROR] ${SERVICE_NAME} failed to start. Check logs:"
  echo "        journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
  exit 1
fi

echo "=============================================="
echo " Deployment complete."
echo "=============================================="
