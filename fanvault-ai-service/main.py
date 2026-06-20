import asyncio
import json
import os
import re
import time

import boto3
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import config
from providers.openai_provider import OpenAIProvider
from providers.bedrock_provider import BedrockProvider
from validators.metadata_validator import validate_metadata
from metrics.ai_metrics import emit_metrics

app = FastAPI(title="FanVault AI Service", docs_url=None, redoc_url=None)

_IMAGE_KEY_RE = re.compile(r"^products/[a-zA-Z0-9\-_./]+$")

_openai_provider: OpenAIProvider | None = None
_bedrock_provider: BedrockProvider | None = None


@app.on_event("startup")
async def _load_secrets() -> None:
    if not config.USE_SECRETS_MANAGER:
        return
    try:
        import json as _json
        sm = boto3.client("secretsmanager", region_name=config.AWS_REGION)
        secret_str = sm.get_secret_value(SecretId=config.SECRET_ID)["SecretString"]
        secret = _json.loads(secret_str)
        if "openai_api_key" in secret:
            os.environ["OPENAI_API_KEY"] = secret["openai_api_key"]
            config.OPENAI_API_KEY = secret["openai_api_key"]
        print("[ai-service] Secrets loaded from Secrets Manager")
    except Exception as exc:
        print(f"[ai-service] Secrets Manager load failed: {exc}")


def _get_chain():
    global _openai_provider, _bedrock_provider
    if _openai_provider is None:
        _openai_provider = OpenAIProvider()
    if _bedrock_provider is None:
        _bedrock_provider = BedrockProvider()
    if config.AI_PROVIDER == "bedrock":
        return [_bedrock_provider, _openai_provider]
    return [_openai_provider, _bedrock_provider]


async def _fetch_image(image_key: str) -> tuple[bytes, str]:
    s3 = boto3.client("s3", region_name=config.AWS_REGION)
    loop = asyncio.get_event_loop()

    def _get():
        resp = s3.get_object(Bucket=config.S3_PRODUCT_IMAGES_BUCKET, Key=image_key)
        return resp["Body"].read(), resp.get("ContentType", "image/jpeg")

    return await loop.run_in_executor(None, _get)


class MetadataRequest(BaseModel):
    imageKey: str


@app.get("/health")
def health():
    return {"status": "ok", "service": "fanvault-ai-service"}


@app.post("/generate-metadata")
async def generate_metadata(req: MetadataRequest):
    if not _IMAGE_KEY_RE.match(req.imageKey) or ".." in req.imageKey:
        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "INVALID_IMAGE_KEY",
                "message": "imageKey must start with products/ and contain only safe characters",
            },
        )

    start = time.time()

    try:
        image_bytes, mime_type = await _fetch_image(req.imageKey)
    except Exception as exc:
        return JSONResponse(
            status_code=503,
            content={
                "success": False,
                "error": "AI_UNAVAILABLE",
                "message": f"Failed to fetch image: {exc}",
                "details": [],
            },
        )

    chain = _get_chain()
    errors = []
    failover = False

    for i, provider in enumerate(chain):
        if i > 0:
            failover = True
        try:
            raw = await asyncio.wait_for(
                provider.generate_product_metadata(image_bytes, mime_type),
                timeout=config.AI_TIMEOUT_S,
            )
            if isinstance(raw, str):
                raw = json.loads(raw)
            valid, errs = validate_metadata(raw)
            if not valid:
                raise ValueError(f"Schema validation failed: {errs}")
            latency_ms = int((time.time() - start) * 1000)
            emit_metrics(provider.get_name(), success=True, failover=failover, latency_ms=latency_ms)
            return {
                "success": True,
                "data": raw,
                "provider": provider.get_name(),
                "latencyMs": latency_ms,
            }
        except Exception as exc:
            errors.append({"provider": provider.get_name(), "reason": str(exc)})
            latency_ms = int((time.time() - start) * 1000)
            emit_metrics(provider.get_name(), success=False, failover=failover, latency_ms=latency_ms)

    return JSONResponse(
        status_code=503,
        content={
            "success": False,
            "error": "AI_UNAVAILABLE",
            "message": "All AI providers failed",
            "details": errors,
        },
    )
