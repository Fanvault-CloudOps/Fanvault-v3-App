# fanvault-ai-service

AI product metadata generation service for FanVault. Given an S3 image key, it fetches the image and calls **AWS Bedrock** (`amazon.nova-pro-v1:0`) to generate structured product metadata: title, description, category, and tags.

- **Port:** `8000`
- **Runtime:** Python 3.12, FastAPI, Uvicorn
- **AI Provider:** AWS Bedrock — `amazon.nova-pro-v1:0` (multimodal)
- **Auth:** Not exposed externally; called internally by `fanvault-commerce-service` (admin-only)

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  fanvault-ai-service  — Request Flow                                        │
└─────────────────────────────────────────────────────────────────────────────┘

  Commerce Service (admin admin.controller.js)
    │
    │  POST http://ai-service:8000/generate-metadata
    │  { "imageKey": "products/abc123.jpg" }
    ▼
  FastAPI app (main.py)
    │
    ├─ 1. Validate imageKey: must match ^products/[a-zA-Z0-9\-_./]+$
    │       Path traversal check: ".." not allowed
    │
    ├─ 2. _fetch_image(imageKey)
    │       boto3 S3.get_object(Bucket=S3_PRODUCT_IMAGES_BUCKET, Key=imageKey)
    │       Returns: (image_bytes, mime_type)
    │
    ├─ 3. BedrockClient.generate(image_bytes, mime_type)
    │       ├─ _ensure_fresh_client()
    │       │     If BEDROCK_ASSUME_ROLE_ARN set:
    │       │       STS.assume_role → temporary credentials → bedrock-runtime client
    │       │       Refreshes 5 min before expiry (thread-safe, DCL pattern)
    │       │     Else: boto3.client("bedrock-runtime") with ambient IRSA creds
    │       │
    │       ├─ Build multimodal message:
    │       │     role: "user"
    │       │     content: [{ image: { format: png|jpeg|gif|webp, source: { bytes: ... } } }]
    │       │
    │       ├─ bedrock-runtime.converse(
    │       │     modelId: "amazon.nova-pro-v1:0",
    │       │     system: [{ text: SYSTEM_PROMPT }],
    │       │     inferenceConfig: { maxTokens: 500, temperature: 0.1 }
    │       │   )
    │       │
    │       ├─ Retry: up to 3 attempts, exponential backoff (1s, 2s) on ThrottlingException
    │       └─ Parse JSON from response text → validate schema → return dict
    │
    ├─ 4. validate_metadata(raw)
    │       Checks: title ≤200 chars, description ≤500 chars,
    │               category in enum, tags is list of 3–8 strings
    │
    ├─ 5. emit_metrics("bedrock", success, failover, latency_ms)
    │       Structured JSON log → CloudWatch (via stdout + log group)
    │
    └─ 6. Return { success: true, data: {...}, provider: "bedrock", modelId, latencyMs }
```

### System Prompt

The model is instructed to return **only** a raw JSON object (no markdown, no code blocks):

```
You are a product metadata generator for a fan merchandise e-commerce store.
Analyze the provided product image and return ONLY a valid JSON object with:
- title (string, max 200 chars): concise product name
- description (string, max 500 chars): engaging product description
- category (one of: sports, movies, shows, games, collectibles, apparel, accessories)
- tags (array of 3-8 lowercase strings for search)
```

### Cross-Account Bedrock Access (Dev)

In the dev environment, Bedrock is accessed via STS cross-account role assumption:
- **Dev cluster IRSA role** (`fanvault-ai-irsa-role` in account `773384830607`) assumes
- **Bedrock role** (`fanvault-bedrock-cross-account-role` in account `899071933396`)
- BedrockClient automatically refreshes credentials 5 minutes before expiry

---

## API Reference

### POST /generate-metadata

Called internally by `fanvault-commerce-service`. Requires the calling pod to have the `fanvault-ai-irsa-role` IRSA annotation.

```json
Request:
{ "imageKey": "products/abc123-uuid.jpg" }

Validation:
- imageKey must match ^products/[a-zA-Z0-9\-_./]+$
- Must not contain ".." (path traversal guard)

Response 200:
{
  "success":   true,
  "data": {
    "title":       "CSK Jersey 2024 Limited Edition",
    "description": "Official Chennai Super Kings IPL jersey with breathable fabric...",
    "category":    "apparel",
    "tags":        ["cricket", "csk", "ipl", "jersey", "sports", "india"]
  },
  "provider":  "bedrock",
  "modelId":   "amazon.nova-pro-v1:0",
  "latencyMs": 2341
}

Response 400 (invalid imageKey):
{ "success": false, "error": "INVALID_IMAGE_KEY", "message": "..." }

Response 503 (S3 fetch failed):
{ "success": false, "error": "IMAGE_FETCH_FAILED", "message": "..." }

Response 503 (Bedrock timeout):
{ "success": false, "error": "AI_TIMEOUT", "message": "Bedrock did not respond within 30s" }

Response 503 (Bedrock error):
{ "success": false, "error": "AI_UNAVAILABLE", "message": "..." }
```

### GET /health

```json
{ "status": "ok", "service": "fanvault-ai-service" }
```

### GET /health/bedrock

Calls STS `GetCallerIdentity` to verify AWS credentials and Bedrock access:

```json
Response 200 (healthy):
{
  "status":   "ok",
  "model_id": "amazon.nova-pro-v1:0",
  "region":   "us-east-1",
  "iam_arn":  "arn:aws:sts::773384830607:assumed-role/fanvault-ai-irsa-role/..."
}

Response 503 (degraded):
{
  "status":  "degraded",
  "model_id": "amazon.nova-pro-v1:0",
  "region":  "us-east-1",
  "error":   "NoCredentials — IRSA or AWS credentials not configured"
}
```

---

## Bedrock Retry + Timeout Strategy

```
Client timeout: AI_TIMEOUT_MS (default 30,000ms)
                asyncio.wait_for wraps the entire Bedrock call

Throttle retry: Up to 3 attempts
  attempt 1: immediate
  attempt 2: sleep 1s
  attempt 3: sleep 2s
  → raises BedrockThrottleError after 3 failures

Structured log on each throttle:
  { "event": "bedrock_throttle", "attempt": N, "retry_delay_s": X, "latency_ms": Y }
```

---

## Metrics & Observability

`metrics/ai_metrics.py` emits structured JSON logs on every call (captured by CloudWatch via stdout):

```json
{
  "event":       "bedrock_generate",
  "model_id":    "amazon.nova-pro-v1:0",
  "latency_ms":  2341,
  "input_tokens": 1024,
  "output_tokens": 87,
  "attempt":     1
}
```

On errors:
```json
{ "event": "bedrock_throttle", "attempt": 2, "retry_delay_s": 1.0, "latency_ms": 350 }
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8000` | Uvicorn port |
| `ENVIRONMENT` | `production` | dev / production |
| `AWS_REGION` | `us-east-1` | AWS region for Bedrock and S3 |
| `BEDROCK_MODEL_ID` | `amazon.nova-pro-v1:0` | Bedrock model ID |
| `AI_TIMEOUT_MS` | `30000` | Per-request Bedrock timeout in milliseconds |
| `S3_PRODUCT_IMAGES_BUCKET` | — | S3 bucket name for product images |
| `BEDROCK_ASSUME_ROLE_ARN` | `""` | Cross-account role ARN; empty = use ambient IRSA creds |

**Production Kubernetes (IRSA):**
- ServiceAccount annotated with `eks.amazonaws.com/role-arn: arn:aws:iam::773384830607:role/fanvault-ai-irsa-role`
- The role has `bedrock:InvokeModel` + `s3:GetObject` on the product images bucket

---

## Metadata Schema Validation

`validators/metadata_validator.py` validates the Bedrock response before returning it:

```python
VALID_CATEGORIES = {"sports", "movies", "shows", "games", "collectibles", "apparel", "accessories"}

Rules:
  title:       str, non-empty, len ≤ 200
  description: str, non-empty, len ≤ 500
  category:    str, must be in VALID_CATEGORIES
  tags:        list, 3 ≤ len ≤ 8, all items are non-empty strings
```

If validation fails, the service raises `ValueError("Schema validation failed: ...")` which surfaces as `AI_UNAVAILABLE`.

---

## Source Structure

```
fanvault-ai-service/
├── main.py                       # FastAPI app: /health, /health/bedrock, /generate-metadata
├── config.py                     # Environment variable bindings
├── services/
│   └── bedrock_client.py         # BedrockClient: generate(), stream_generate(), health_check()
│                                 # Cross-account STS assume_role with auto-refresh
├── validators/
│   └── metadata_validator.py     # JSON schema validation for Bedrock responses
├── metrics/
│   └── ai_metrics.py             # Structured JSON metric emitter (stdout → CloudWatch)
├── requirements.txt              # fastapi, uvicorn, boto3, pydantic
├── requirements-dev.txt          # + pytest, httpx
├── Dockerfile                    # Python 3.12-slim, non-root user
└── docs/
    └── bedrock-migration.md      # Bedrock migration notes
```

---

## Running Locally

```bash
# Prerequisites: AWS credentials with Bedrock + S3 access
pip install -r requirements.txt

# Environment
export AWS_REGION=us-east-1
export BEDROCK_MODEL_ID=amazon.nova-pro-v1:0
export S3_PRODUCT_IMAGES_BUCKET=fanvault-dev-product-images-773384830607
export AI_TIMEOUT_MS=30000

uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Health check
curl http://localhost:8000/health
curl http://localhost:8000/health/bedrock

# Test metadata generation
curl -X POST http://localhost:8000/generate-metadata \
  -H 'Content-Type: application/json' \
  -d '{"imageKey": "products/some-image.jpg"}'
```

---

## Docker

```dockerfile
# Dockerfile uses Python 3.12-slim, runs as non-root user
docker build -t fanvault-ai-service .
docker run -p 8000:8000 \
  -e AWS_REGION=us-east-1 \
  -e BEDROCK_MODEL_ID=amazon.nova-pro-v1:0 \
  -e S3_PRODUCT_IMAGES_BUCKET=fanvault-dev-product-images-773384830607 \
  fanvault-ai-service
```

---

## Kubernetes Resources

Deployed via Helm chart `charts/ai-service` in [Fanvault-GitOps](../../Fanvault-GitOps/).

| Resource | Value |
|---|---|
| CPU request / limit | 100m / 500m |
| Memory request / limit | 256Mi / 512Mi |
| HPA min / max | 2 / 3 (dev), 2 / 5 (prod) |
| Liveness probe delay | 15s (longer than other services — model warm-up) |
| Readiness probe delay | 10s |
| Network policy ingress | commerce-service pods only |
| IRSA role | `arn:aws:iam::773384830607:role/fanvault-ai-irsa-role` |
