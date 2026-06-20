import base64
import json

from openai import AsyncOpenAI

from providers.ai_provider import AIProvider, SYSTEM_PROMPT
import config


class OpenAIProvider(AIProvider):
    def __init__(self) -> None:
        self._client = AsyncOpenAI(api_key=config.OPENAI_API_KEY, timeout=config.AI_TIMEOUT_S)

    def get_name(self) -> str:
        return "openai"

    async def generate_product_metadata(self, image_bytes: bytes, mime_type: str) -> dict:
        b64 = base64.b64encode(image_bytes).decode()
        response = await self._client.chat.completions.create(
            model=config.OPENAI_MODEL_ID,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{mime_type};base64,{b64}",
                                "detail": "low",
                            },
                        }
                    ],
                },
            ],
            max_tokens=500,
            temperature=0.1,
        )
        return json.loads(response.choices[0].message.content.strip())
