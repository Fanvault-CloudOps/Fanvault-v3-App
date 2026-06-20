#!/usr/bin/env bash
# FanVault Container Validation Script for EC2 / Linux
# Automates starting, building, and verifying the containerized stack.

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0;68m' # No Color
CLEAR='\033[0m'

echo -e "${CYAN}Checking if Docker daemon is running...${CLEAR}"
if ! docker ps > /dev/null 2>&1; then
    echo -e "${RED}❌ Docker daemon is not active. Please start docker ('sudo systemctl start docker') and ensure your user is in the 'docker' group.${CLEAR}"
    exit 1
fi
echo -e "${GREEN}✅ Docker daemon is active.${CLEAR}"

# ── Check Compose Command ──
COMPOSE_CMD=""
if docker compose version > /dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
elif docker-compose version > /dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
else
    echo -e "${RED}❌ Neither 'docker compose' nor 'docker-compose' could be found. Please install docker-compose plugin.${CLEAR}"
    exit 1
fi
echo -e "${GREEN}✅ Compose command identified: $COMPOSE_CMD${CLEAR}"

# ── Check Environment File ──
echo -e "\n${CYAN}Checking for .env file...${CLEAR}"
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️ No .env file found. Creating a template at .env${CLEAR}"
    cat <<EOF > .env
# AWS Credentials (required to connect to your remote DynamoDB tables)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SESSION_TOKEN=

# App JWT Secrets
JWT_SECRET=supersecretjwtsigningkeyhere123!
JWT_REFRESH_SECRET=supersecretjwtrefreshkeyhere123!
EOF
    echo -e "${YELLOW}Please fill in your AWS credentials in the generated .env file before running again.${CLEAR}"
    exit 0
else
    echo -e "${GREEN}✅ .env file detected.${CLEAR}"
fi

# ── Build Containers ──
echo -e "\n${CYAN}Building images...${CLEAR}"
$COMPOSE_CMD build

# ── Start Stack ──
echo -e "\n${CYAN}Starting Docker Compose stack...${CLEAR}"
$COMPOSE_CMD up -d

echo -e "${YELLOW}Waiting 15 seconds for health checks to initialize...${CLEAR}"
sleep 15

# ── Run Health Diagnostics ──
echo -e "\n${CYAN}Running diagnostics...${CLEAR}"

success=true

# Frontend Check
if curl -s -f http://localhost/health > /dev/null; then
    echo -e "${GREEN}✅ Frontend Service: HEALTHY${CLEAR}"
else
    echo -e "${RED}❌ Frontend Service: UNHEALTHY${CLEAR}"
    success=false
fi

# User Service Routing Check (via Nginx proxy)
if curl -s -I http://localhost/api/users/me | grep -qE "401|403"; then
    echo -e "${GREEN}✅ User Service routing check succeeded (Returned 401/403 as expected).${CLEAR}"
else
    echo -e "${RED}❌ User Service Routing check failed${CLEAR}"
    success=false
fi

# Commerce Service Check (via Nginx proxy)
if curl -s -f http://localhost/api/products > /dev/null; then
    echo -e "${GREEN}✅ Commerce products retrieval check succeeded.${CLEAR}"
else
    echo -e "${RED}❌ Commerce Service products check failed${CLEAR}"
    success=false
fi

echo -e "\n${CYAN}Container statuses:${CLEAR}"
$COMPOSE_CMD ps

if [ "$success" = true ]; then
    echo -e "\n${GREEN}🎉 All checks passed successfully! Images are verified and ready.${CLEAR}"
else
    echo -e "\n${YELLOW}⚠️ Some health checks failed. Run '$COMPOSE_CMD logs' to troubleshoot container logs.${CLEAR}"
fi
