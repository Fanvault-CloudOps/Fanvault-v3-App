import asyncio
import json
import re
import time

import boto3
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import config
from services.bedrock_client import BedrockClient
from validators.metadata_validator import validate_metadata
from metrics.ai_metrics import emit_metrics

app = FastAPI(title="FanVault AI Service", docs_url=None, redoc_url=None)

_IMAGE_KEY_RE = re.compile(r"^products/[a-zA-Z0-9\-_./]+$")

_bedrock = BedrockClient()


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


@app.get("/health/bedrock")
async def health_bedrock():
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _bedrock.health_check)
    status_code = 200 if result["status"] == "ok" else 503
    return JSONResponse(status_code=status_code, content=result)


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
                "error": "IMAGE_FETCH_FAILED",
                "message": f"Failed to fetch image from S3: {exc}",
            },
        )

    loop = asyncio.get_event_loop()
    try:
        raw = await asyncio.wait_for(
            loop.run_in_executor(None, _bedrock.generate, image_bytes, mime_type),
            timeout=config.AI_TIMEOUT_S,
        )
        if isinstance(raw, str):
            raw = json.loads(raw)
        valid, errs = validate_metadata(raw)
        if not valid:
            raise ValueError(f"Schema validation failed: {errs}")
    except asyncio.TimeoutError:
        latency_ms = int((time.time() - start) * 1000)
        emit_metrics("bedrock", success=False, failover=False, latency_ms=latency_ms)
        return JSONResponse(
            status_code=503,
            content={
                "success": False,
                "error": "AI_TIMEOUT",
                "message": f"Bedrock did not respond within {config.AI_TIMEOUT_S}s",
            },
        )
    except Exception as exc:
        latency_ms = int((time.time() - start) * 1000)
        emit_metrics("bedrock", success=False, failover=False, latency_ms=latency_ms)
        return JSONResponse(
            status_code=503,
            content={
                "success": False,
                "error": "AI_UNAVAILABLE",
                "message": str(exc),
            },
        )

    latency_ms = int((time.time() - start) * 1000)
    emit_metrics("bedrock", success=True, failover=False, latency_ms=latency_ms)
    return {
        "success": True,
        "data": raw,
        "provider": "bedrock",
        "modelId": config.BEDROCK_MODEL_ID,
        "latencyMs": latency_ms,
    }
