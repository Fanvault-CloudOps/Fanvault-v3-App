# Bedrock Migration Guide

## Architecture

```
Frontend (admin)
    │
    ▼
POST /api/admin/generate-metadata
    │  (Nginx → commerce-service)
    ▼
commerce-service
    │  POST http://ai-service:8000/generate-metadata
    ▼
fanvault-ai-service
    │
    ├── S3 GetObject (product image)
    │
    └── services/BedrockClient.generate()
            │
            └── bedrock-runtime Converse API
                    └── us.anthropic.claude-3-5-haiku-20241022-v1:0
                        (cross-region inference profile)
```

## Authentication Flow

The AI service uses **IAM Roles for Service Accounts (IRSA)** — no static credentials anywhere.

```
Pod starts
  │
  └── K8s ServiceAccount annotated with:
        eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT:role/fanvault-ai-irsa-role
          │
          └── OIDC provider exchanges JWT for temporary AWS credentials
                │
                └── boto3 picks up credentials automatically from
                    the pod's instance metadata endpoint
```

boto3 credential resolution order (no configuration needed):
1. Environment variables (not set — intentional)
2. AWS credentials file (not present in container — intentional)
3. **Instance metadata (IMDS) / IRSA token** ← this is what fires in EKS

## IRSA Configuration

The `fanvault-ai-irsa-role` grants:

| Permission | Resource | Purpose |
|-----------|----------|---------|
| `bedrock:InvokeModel` | inference-profile + foundation-model ARNs | Generate metadata |
| `bedrock:InvokeModelWithResponseStream` | same | Streaming (future) |
| `cloudwatch:PutMetricData` | `*` | Emit AI metrics |
| `s3:GetObject` | `fanvault-*-product-images-*/*` | Fetch product images |
| `secretsmanager:GetSecretValue` | `fanvault-*-app-secrets*` | Reserved for future use |

Trust policy allows:
- `system:serviceaccount:dev:ai-service`
- `system:serviceaccount:prod:ai-service`

## Environment Variables

| Variable | Default | Required | Notes |
|----------|---------|----------|-------|
| `AWS_REGION` | `us-east-1` | Yes | AWS region for all clients |
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-3-5-haiku-20241022-v1:0` | Yes | Cross-region inference profile ID |
| `AI_TIMEOUT_MS` | `30000` | No | Per-request timeout in milliseconds |
| `S3_PRODUCT_IMAGES_BUCKET` | `` | Yes | S3 bucket holding product images |
| `PORT` | `8000` | No | HTTP port |
| `ENVIRONMENT` | `production` | No | Used in CloudWatch metric dimensions |

Removed variables (no longer needed):
- `OPENAI_API_KEY` — no OpenAI
- `OPENAI_MODEL_ID` — no OpenAI
- `AI_PROVIDER` — single provider now
- `USE_SECRETS_MANAGER` — no API key to fetch
- `SECRET_ID` — no API key to fetch

## Model

**`us.anthropic.claude-3-5-haiku-20241022-v1:0`** — Claude 3.5 Haiku via AWS cross-region inference.

The `us.` prefix is an AWS-managed inference profile that automatically routes requests across `us-east-1`, `us-west-2`, and `us-east-2` for higher throughput and availability. No additional configuration needed.

## Endpoints

### `GET /health`
Liveness probe. Always returns 200 if the process is running.

```json
{"status": "ok", "service": "fanvault-ai-service"}
```

### `GET /health/bedrock`
Readiness probe with IAM verification. Calls `sts:GetCallerIdentity` to confirm credentials are valid.

```json
{
  "status": "ok",
  "model_id": "us.anthropic.claude-3-5-haiku-20241022-v1:0",
  "region": "us-east-1",
  "iam_arn": "arn:aws:sts::773384830607:assumed-role/fanvault-ai-irsa-role/..."
}
```

Returns `503` if credentials are missing or invalid.

### `POST /generate-metadata`
```json
// Request
{"imageKey": "products/abc123.jpg"}

// Response
{
  "success": true,
  "data": {
    "title": "Mumbai Indians Jersey 2024",
    "description": "...",
    "category": "sports",
    "tags": ["ipl", "cricket", "jersey"]
  },
  "provider": "bedrock",
  "modelId": "us.anthropic.claude-3-5-haiku-20241022-v1:0",
  "latencyMs": 1240
}
```

## Retry Behaviour

`BedrockClient.generate()` retries up to **3 times** on `ThrottlingException` with exponential backoff (1s, 2s, 4s). All other errors fail immediately. After 3 throttle retries, raises `BedrockThrottleError`.

## Local Development

```bash
# Install dependencies
pip install -r requirements.txt

# Set required env vars
export AWS_REGION=us-east-1
export S3_PRODUCT_IMAGES_BUCKET=fanvault-dev-product-images-773384830607
export BEDROCK_MODEL_ID=us.anthropic.claude-3-5-haiku-20241022-v1:0

# Configure AWS credentials (uses your local profile — IRSA is not available locally)
aws configure  # or export AWS_PROFILE=your-profile

# Run
uvicorn main:app --reload --port 8000

# Test
curl http://localhost:8000/health
curl http://localhost:8000/health/bedrock
```

## Deployment Process

1. Push to `main` → CI builds Docker image, pushes to ECR Dev, updates `environments/dev/values-ai.yaml`
2. ArgoCD detects the tag change and syncs the `dev` namespace (auto-sync enabled)
3. New pods start; IRSA credentials are injected automatically via the annotated ServiceAccount
4. Push a `v*.*.*` tag → CI requires manual approval via `environment: prod`, then pushes to ECR Prod and updates `environments/prod/values-ai.yaml`

## Rollback Procedure

**Option A — Helm values rollback (fastest, no image rebuild):**
```bash
cd Fanvault-GitOps
git log --oneline environments/dev/values-ai.yaml
git revert <commit>
git push origin main
# ArgoCD re-syncs automatically within ~3 minutes
```

**Option B — ArgoCD UI:**
History → select previous revision → Rollback

**Option C — kubectl (emergency):**
```bash
kubectl rollout undo deployment/dev-ai-service -n dev
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `/health/bedrock` returns `NoCredentials` | IRSA annotation missing or OIDC provider not trusted | Check `kubectl describe sa ai-service -n dev`; verify `eks.amazonaws.com/role-arn` annotation |
| `ThrottlingException` in logs | Too many concurrent requests | BedrockClient retries automatically; check HPA scaling |
| `ValidationException` | Wrong model ID format | Verify `BEDROCK_MODEL_ID` env var in ConfigMap |
| `AccessDeniedException` | IRSA role missing Bedrock permission | Check IAM policy attached to `fanvault-ai-irsa-role` |
| S3 403 | IRSA role missing S3 permission, or wrong bucket | Verify `S3_PRODUCT_IMAGES_BUCKET` and IAM policy `S3ProductImagesRead` statement |
| JSON parse error in metadata | Model returned non-JSON | Check CloudWatch logs for raw model output; system prompt may need tuning |
