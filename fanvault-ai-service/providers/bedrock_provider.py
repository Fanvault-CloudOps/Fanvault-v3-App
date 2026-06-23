import asyncio
import base64
import json
import logging
import time
from abc import ABC, abstractmethod
from typing import AsyncGenerator

import openai
from openai import AsyncOpenAI

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


class AIProvider(ABC):
    @abstractmethod
    async def generate(self, image_bytes: bytes, mime_type: str) -> dict:
        ...

    @abstractmethod
    async def health_check(self) -> dict:
        ...


class BedrockApiKeyProvider(AIProvider):
    def __init__(self) -> None:
        self._model_id = config.BEDROCK_MODEL_ID
        self._client = AsyncOpenAI(
            api_key=config.BEDROCK_API_KEY,
            base_url=f"https://bedrock.{config.BEDROCK_REGION}.amazonaws.com/v1/",
        )

    async def generate(self, image_bytes: bytes, mime_type: str) -> dict:
        ext = mime_type.split("/")[-1].lower() if "/" in mime_type else "jpeg"
        fmt = ext if ext in _VALID_IMAGE_FORMATS else "jpeg"

        b64 = base64.b64encode(image_bytes).decode()
        data_url = f"data:image/{fmt};base64,{b64}"

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": data_url}}],
            },
        ]

        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRIES):
            t0 = time.monotonic()
            try:
                response = await self._client.chat.completions.create(
                    model=self._model_id,
                    messages=messages,
                    max_tokens=500,
                    temperature=0.1,
                )
            except openai.RateLimitError as exc:
                delay = _RETRY_BASE_DELAY_S * (2 ** attempt)
                latency_ms = int((time.monotonic() - t0) * 1000)
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
                    await asyncio.sleep(delay)
                continue
            except openai.AuthenticationError as exc:
                raise BedrockClientError(f"Bedrock auth error — check BEDROCK_API_KEY: {exc}") from exc
            except openai.PermissionDeniedError as exc:
                raise BedrockClientError(f"Bedrock access denied — check model permissions: {exc}") from exc
            except openai.NotFoundError as exc:
                raise BedrockClientError(f"Bedrock model not found [{self._model_id}]: {exc}") from exc
            except openai.APITimeoutError as exc:
                raise BedrockClientError(f"Bedrock request timed out: {exc}") from exc
            except openai.APIConnectionError as exc:
                raise BedrockClientError(f"Bedrock connection failed: {exc}") from exc
            except openai.APIStatusError as exc:
                raise BedrockClientError(f"Bedrock [{exc.status_code}]: {exc}") from exc

            latency_ms = int((time.monotonic() - t0) * 1000)
            usage = response.usage
            logger.info(
                json.dumps({
                    "event": "bedrock_generate",
                    "model_id": self._model_id,
                    "latency_ms": latency_ms,
                    "input_tokens": usage.prompt_tokens if usage else None,
                    "output_tokens": usage.completion_tokens if usage else None,
                    "attempt": attempt + 1,
                })
            )
            text = response.choices[0].message.content.strip()
            return json.loads(text)

        raise last_exc or BedrockClientError("generate failed after retries")

    async def stream_generate(self, image_bytes: bytes, mime_type: str) -> AsyncGenerator[str, None]:
        ext = mime_type.split("/")[-1].lower() if "/" in mime_type else "jpeg"
        fmt = ext if ext in _VALID_IMAGE_FORMATS else "jpeg"

        b64 = base64.b64encode(image_bytes).decode()
        data_url = f"data:image/{fmt};base64,{b64}"

        try:
            stream = await self._client.chat.completions.create(
                model=self._model_id,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": [{"type": "image_url", "image_url": {"url": data_url}}],
                    },
                ],
                max_tokens=500,
                temperature=0.1,
                stream=True,
            )
        except openai.APIStatusError as exc:
            raise BedrockClientError(f"Bedrock stream error: {exc}") from exc

        async for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                yield delta

    async def health_check(self) -> dict:
        if not config.BEDROCK_API_KEY:
            return {
                "status": "degraded",
                "model_id": self._model_id,
                "region": config.BEDROCK_REGION,
                "auth": "api-key",
                "error": "BEDROCK_API_KEY not configured",
            }
        return {
            "status": "ok",
            "model_id": self._model_id,
            "region": config.BEDROCK_REGION,
            "auth": "api-key",
        }
