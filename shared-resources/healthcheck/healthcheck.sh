#!/usr/bin/env bash
# =============================================================================
# healthcheck.sh — FanVault v2 Service Health Checker
#
# Run from any machine that has network access to the private backend subnets
# (e.g., a Bastion host or the frontend EC2 instance).
#
# Usage: ./healthcheck.sh
# =============================================================================
set -euo pipefail

AUTH_HOST="${AUTH_HOST:-auth-svc.fanvault.internal}"
AUTH_PORT="${AUTH_PORT:-3001}"
COMMERCE_HOST="${COMMERCE_HOST:-commerce-svc.fanvault.internal}"
COMMERCE_PORT="${COMMERCE_PORT:-3002}"

PASS=0
FAIL=0

check() {
  local label="$1"
  local url="$2"
  local response
  response=$(curl -sf --max-time 5 "${url}" 2>&1) || true
  if echo "${response}" | grep -q '"status":"ok"'; then
    echo "[PASS] ${label}: ${url}"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] ${label}: ${url}"
    echo "       Response: ${response}"
    FAIL=$((FAIL + 1))
  fi
}

echo "======================================"
echo " FanVault v2 — Service Health Checks"
echo " $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "======================================"

check "Identity Service" "http://${AUTH_HOST}:${AUTH_PORT}/health"
check "Commerce Service" "http://${COMMERCE_HOST}:${COMMERCE_PORT}/health"

echo "--------------------------------------"
echo " PASSED: ${PASS}  FAILED: ${FAIL}"
echo "======================================"

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
