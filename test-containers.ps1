# FanVault Container Validation Script
# This script automates starting, building, and verifying the containerized stack.

$ErrorActionPreference = "Stop"

# ── 1. Check Docker Daemon ───────────────────────────────────────────────────
Write-Host "Checking if Docker daemon is running..." -ForegroundColor Cyan
try {
    & docker ps > $null 2>&1
    Write-Host "✅ Docker daemon is active." -ForegroundColor Green
} catch {
    Write-Error "❌ Docker daemon is not running. Please start Docker Desktop and try again."
}

# ── 2. Check/Load Environment File ───────────────────────────────────────────
Write-Host "`nChecking for .env file..." -ForegroundColor Cyan
$envFilePath = Join-Path $PSScriptRoot ".env"

if (-not (Test-Path $envFilePath)) {
    Write-Host "⚠️ No .env file found. Creating a template at $envFilePath" -ForegroundColor Yellow
    $template = @"
# AWS Credentials (required to connect to your remote DynamoDB tables)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SESSION_TOKEN=

# App JWT Secrets
JWT_SECRET=supersecretjwtsigningkeyhere123!
JWT_REFRESH_SECRET=supersecretjwtrefreshkeyhere123!
"@
    Set-Content -Path $envFilePath -Value $template
    Write-Host "Please open the generated .env file and fill in your AWS credentials before proceeding." -ForegroundColor Yellow
    exit
} else {
    Write-Host "✅ .env file detected." -ForegroundColor Green
}

# ── 3. Build Containers ───────────────────────────────────────────────────────
Write-Host "`nBuilding images..." -ForegroundColor Cyan
& docker compose build

# ── 4. Spin up services ───────────────────────────────────────────────────────
Write-Host "`nStarting Docker Compose stack..." -ForegroundColor Cyan
& docker compose up -d

Write-Host "Waiting 15 seconds for health checks to initialize..." -ForegroundColor Yellow
Start-Sleep -Seconds 15

# ── 5. Run Health Diagnostics ─────────────────────────────────────────────────
Write-Host "`nRunning diagnostics..." -ForegroundColor Cyan

$success = $true

# Frontend Check
try {
    $feResponse = Invoke-RestMethod -Uri "http://localhost/health" -Method Get -TimeoutSec 5
    if ($feResponse.status -eq "ok") {
        Write-Host "✅ Frontend Service: HEALTHY" -ForegroundColor Green
    } else {
        throw "Unexpected status: $($feResponse.status)"
    }
} catch {
    Write-Host "❌ Frontend Service: UNHEALTHY ($($_.Exception.Message))" -ForegroundColor Red
    $success = $false
}

# User Service Check (via Nginx proxy)
try {
    $idResponse = Invoke-RestMethod -Uri "http://localhost/api/users/me" -Method Get -TimeoutSec 5
    Write-Host "✅ User Service routing check succeeded." -ForegroundColor Green
} catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -in 401, 403) {
        Write-Host "✅ User Service routing check succeeded (Returned 401/403 as expected)." -ForegroundColor Green
    } else {
        Write-Host "❌ User Service Routing check failed ($($_.Exception.Message))" -ForegroundColor Red
        $success = $false
    }
}

# Commerce Service Check (via Nginx proxy)
try {
    $commerceResponse = Invoke-RestMethod -Uri "http://localhost/api/products" -Method Get -TimeoutSec 5
    Write-Host "✅ Commerce products retrieval check succeeded." -ForegroundColor Green
} catch {
    Write-Host "❌ Commerce Service products check failed ($($_.Exception.Message))" -ForegroundColor Red
    $success = $false
}

Write-Host "`nContainer statuses:" -ForegroundColor Cyan
& docker compose ps

if ($success) {
    Write-Host "`n🎉 All checks passed successfully! Images are verified and ready." -ForegroundColor Green
} else {
    Write-Host "`n⚠️ Some health checks failed. Run 'docker compose logs' to troubleshoot container logs." -ForegroundColor Yellow
}
