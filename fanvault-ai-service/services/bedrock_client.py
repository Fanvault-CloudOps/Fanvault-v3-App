import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Generator

import boto3
from botocore.exceptions import ClientError, NoCredentialsError

import config

logger = logging.getLogger(__name__)

_VALID_IMAGE_FORMATS = frozenset({"jpeg", "png", "gif", "webp"})

SYSTEM_PROMPT = (
    "You are a product metadata generator for a fan merchandise e-commerce store.\n"
    "Analyze the provided product image and return ONLY a valid JSON object with these exact fields:\n"
    "- title (string, max 200 chars): concise product name\n"
    "- description (string, max 500 chars): engaging product description\n"
    "- category (one of exactly: sports, movies, shows, games, collectibles, apparel, accessories)\n"
    "- tags (array of 3-8 lowercase strings for search)\n"
    "Return ONLY the raw JSON object. No markdown. No code blocks. No explanation."
)

_MAX_RETRIES = 3
_RETRY_BASE_DELAY_S = 1.0


class BedrockClientError(Exception):
    pass


class BedrockThrottleError(BedrockClientError):
    pass


class BedrockClient:
    def __init__(self) -> None:
        self._model_id = config.BEDROCK_MODEL_ID
        self._creds_expiry: datetime | None = None
        self._lock = threading.Lock()
        self._refresh_client()

    def _refresh_client(self) -> None:
        if config.BEDROCK_ASSUME_ROLE_ARN:
            sts = boto3.client("sts", region_name=config.AWS_REGION)
            assumed = sts.assume_role(
                RoleArn=config.BEDROCK_ASSUME_ROLE_ARN,
                RoleSessionName="fanvault-ai-bedrock",
                DurationSeconds=3600,
            )
            creds = assumed["Credentials"]
            self._creds_expiry = creds["Expiration"]
            self._client = boto3.client(
                "bedrock-runtime",
                region_name=config.AWS_REGION,
                aws_access_key_id=creds["AccessKeyId"],
                aws_secret_access_key=creds["SecretAccessKey"],
                aws_session_token=creds["SessionToken"],
            )
        else:
            self._client = boto3.client("bedrock-runtime", region_name=config.AWS_REGION)
            self._creds_expiry = None

    def _ensure_fresh_client(self) -> None:
        if self._creds_expiry is None:
            return
        if datetime.now(timezone.utc) >= self._creds_expiry - timedelta(minutes=5):
            with self._lock:
                if datetime.now(timezone.utc) >= self._creds_expiry - timedelta(minutes=5):
                    self._refresh_client()

    def generate(self, image_bytes: bytes, mime_type: str) -> dict:
        self._ensure_fresh_client()

        ext = mime_type.split("/")[-1].lower() if "/" in mime_type else "jpeg"
        fmt = ext if ext in _VALID_IMAGE_FORMATS else "jpeg"

        messages = [
            {
                "role": "user",
                "content": [{"image": {"format": fmt, "source": {"bytes": image_bytes}}}],
            }
        ]
        inference_config = {"maxTokens": 500, "temperature": 0.1}

        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRIES):
            t0 = time.monotonic()
            try:
                response = self._client.converse(
                    modelId=self._model_id,
                    system=[{"text": SYSTEM_PROMPT}],
                    messages=messages,
                    inferenceConfig=inference_config,
                )
            except ClientError as exc:
                code = exc.response["Error"]["Code"]
                latency_ms = int((time.monotonic() - t0) * 1000)
                if code == "ThrottlingException":
                    delay = _RETRY_BASE_DELAY_S * (2 ** attempt)
                    logger.warning(
                        json.dumps({
                            "event": "bedrock_throttle",
                            "attempt": attempt + 1,
                            "retry_delay_s": delay,
                            "latency_ms": latency_ms,
                        })
                    )
                    last_exc = BedrockThrottleError(str(exc))
                    if attempt < _MAX_RETRIES - 1:
                        time.sleep(delay)
                    continue
                raise BedrockClientError(f"Bedrock [{code}]: {exc}") from exc

            latency_ms = int((time.monotonic() - t0) * 1000)
            usage = response.get("usage", {})
            logger.info(
                json.dumps({
                    "event": "bedrock_generate",
                    "model_id": self._model_id,
                    "latency_ms": latency_ms,
                    "input_tokens": usage.get("inputTokens"),
                    "output_tokens": usage.get("outputTokens"),
                    "attempt": attempt + 1,
                })
            )
            text = response["output"]["message"]["content"][0]["text"].strip()
            return json.loads(text)

        raise last_exc or BedrockClientError("generate failed after retries")

    def stream_generate(self, image_bytes: bytes, mime_type: str) -> Generator[str, None, None]:
        self._ensure_fresh_client()

        ext = mime_type.split("/")[-1].lower() if "/" in mime_type else "jpeg"
        fmt = ext if ext in _VALID_IMAGE_FORMATS else "jpeg"

        try:
            response = self._client.converse_stream(
                modelId=self._model_id,
                system=[{"text": SYSTEM_PROMPT}],
                messages=[
                    {
                        "role": "user",
                        "content": [{"image": {"format": fmt, "source": {"bytes": image_bytes}}}],
                    }
                ],
                inferenceConfig={"maxTokens": 500, "temperature": 0.1},
            )
        except ClientError as exc:
            raise BedrockClientError(f"Bedrock stream error: {exc}") from exc

        for event in response["stream"]:
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"]["delta"]
                if "text" in delta:
                    yield delta["text"]

    def health_check(self) -> dict:
        try:
            sts = boto3.client("sts", region_name=config.AWS_REGION)
            identity = sts.get_caller_identity()
            result = {
                "status": "ok",
                "model_id": self._model_id,
                "region": config.AWS_REGION,
                "iam_arn": identity.get("Arn"),
            }
            if config.BEDROCK_ASSUME_ROLE_ARN:
                result["assumed_role_arn"] = config.BEDROCK_ASSUME_ROLE_ARN
            return result
        except NoCredentialsError:
            return {
                "status": "degraded",
                "model_id": self._model_id,
                "region": config.AWS_REGION,
                "error": "NoCredentials — IRSA or AWS credentials not configured",
            }
        except Exception as exc:
            return {
                "status": "degraded",
                "model_id": self._model_id,
                "region": config.AWS_REGION,
                "error": str(exc),
            }
