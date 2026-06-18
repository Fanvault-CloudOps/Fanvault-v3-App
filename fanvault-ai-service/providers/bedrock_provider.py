import asyncio
import json

from providers.ai_provider import AIProvider, SYSTEM_PROMPT
import config

_VALID_FORMATS = frozenset({"jpeg", "png", "gif", "webp"})


class BedrockProvider(AIProvider):
    def __init__(self) -> None:
        import boto3
        self._client = boto3.client("bedrock-runtime", region_name=config.AWS_REGION)

    def get_name(self) -> str:
        return "bedrock"

    async def generate_product_metadata(self, image_bytes: bytes, mime_type: str) -> dict:
        ext = mime_type.split("/")[-1].lower() if "/" in mime_type else "jpeg"
        fmt = ext if ext in _VALID_FORMATS else "jpeg"

        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: self._client.converse(
                modelId=config.BEDROCK_MODEL_ID,
                system=[{"text": SYSTEM_PROMPT}],
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "image": {
                                    "format": fmt,
                                    "source": {"bytes": image_bytes},
                                }
                            }
                        ],
                    }
                ],
                inferenceConfig={"maxTokens": 500, "temperature": 0.1},
            ),
        )
        text = response["output"]["message"]["content"][0]["text"].strip()
        return json.loads(text)
