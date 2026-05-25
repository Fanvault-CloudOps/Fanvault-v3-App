#!/usr/bin/env bash
# =============================================================================
# setup-nginx.sh — Frontend Service (fanvault-frontend)
# Run as root or sudo on the target EC2 frontend instance.
# Requires the React app to already be built (dist/ directory present).
# =============================================================================
set -euo pipefail

APP_DIR="/var/www/fanvault-frontend"
NGINX_CONF_SRC="./nginx.conf"
NGINX_SITE="/etc/nginx/sites-available/fanvault"
NGINX_ENABLED="/etc/nginx/sites-enabled/fanvault"

echo "=============================================="
echo " FanVault Frontend — Nginx Deployment Script"
echo "=============================================="

# ── 1. Install Nginx if not present ──────────────────────────────────────────
if ! command -v nginx &>/dev/null; then
  echo "[INFO] Installing Nginx..."
  apt-get update -y
  apt-get install -y nginx
else
  echo "[INFO] Nginx found: $(nginx -v 2>&1)"
fi

# ── 2. Deploy built static assets ────────────────────────────────────────────
if [ ! -d "./dist" ]; then
  echo "[ERROR] dist/ directory not found."
  echo "        Build the frontend first: npm run build"
  exit 1
fi

echo "[INFO] Deploying static assets to ${APP_DIR}/dist..."
mkdir -p "${APP_DIR}/dist"
rsync -av ./dist/ "${APP_DIR}/dist/"
chown -R www-data:www-data "${APP_DIR}"

# ── 3. Install Nginx site configuration ──────────────────────────────────────
echo "[INFO] Installing Nginx configuration..."
cp "${NGINX_CONF_SRC}" "${NGINX_SITE}"

# Remove the default site to avoid conflicts
rm -f /etc/nginx/sites-enabled/default

# Enable the fanvault site
ln -sf "${NGINX_SITE}" "${NGINX_ENABLED}"

# ── 4. Test and reload Nginx ─────────────────────────────────────────────────
echo "[INFO] Testing Nginx configuration..."
nginx -t

echo "[INFO] Reloading Nginx..."
systemctl enable nginx
systemctl reload nginx

# ── 5. Validate ──────────────────────────────────────────────────────────────
sleep 2
if systemctl is-active --quiet nginx; then
  echo "[OK] Nginx is running."
  echo "[OK] Health check:"
  curl -sf http://localhost/health || echo "[WARN] Health endpoint not responding yet."
else
  echo "[ERROR] Nginx failed to start. Check logs: journalctl -u nginx -n 50"
  exit 1
fi

echo "=============================================="
echo " Frontend deployment complete."
echo " DNS for backend upstreams must resolve via"
echo " Route53 Private Hosted Zone: fanvault.internal"
echo "=============================================="
