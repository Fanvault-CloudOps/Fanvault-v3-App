"""
Unit tests for the FanVault AI service (Bedrock API key provider).
All external I/O (openai, boto3/S3) is mocked so tests run without AWS credentials.
"""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from validators.metadata_validator import validate_metadata


# ── Metadata validator tests ───────────────────────────────────────────────────

VALID_METADATA = {
    "title": "Mumbai Indians Jersey 2024",
    "description": "Official IPL jersey for true fans.",
    "category": "sports",
    "tags": ["ipl", "cricket", "jersey"],
}


def test_validate_metadata_valid():
    ok, errs = validate_metadata(VALID_METADATA)
    assert ok is True
    assert errs is None


def test_validate_metadata_missing_field():
    bad = {**VALID_METADATA}
    del bad["title"]
    ok, errs = validate_metadata(bad)
    assert ok is False
    assert errs is not None


def test_validate_metadata_bad_category():
    bad = {**VALID_METADATA, "category": "not-a-real-category"}
    ok, errs = validate_metadata(bad)
    assert ok is False


def test_validate_metadata_too_many_tags():
    bad = {**VALID_METADATA, "tags": [f"tag{i}" for i in range(20)]}
    ok, errs = validate_metadata(bad)
    assert ok is False


# ── BedrockApiKeyProvider unit tests ──────────────────────────────────────────

def _make_chat_completion(content: str, prompt_tokens: int = 100, completion_tokens: int = 50):
    choice = MagicMock()
    choice.message.content = content
    usage = MagicMock()
    usage.prompt_tokens = prompt_tokens
    usage.completion_tokens = completion_tokens
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage
    return response


class TestBedrockApiKeyProviderGenerate(unittest.TestCase):
    def _run(self, coro):
        return asyncio.get_event_loop().run_until_complete(coro)

    @patch("providers.bedrock_provider.AsyncOpenAI")
    def test_generate_success(self, mock_openai_cls):
        payload = json.dumps(VALID_METADATA)
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            return_value=_make_chat_completion(payload)
        )
        mock_openai_cls.return_value = mock_client

        import config as cfg
        with patch.object(cfg, "BEDROCK_API_KEY", "test-key"), \
             patch.object(cfg, "BEDROCK_REGION", "us-east-1"):
            from providers.bedrock_provider import BedrockApiKeyProvider
            provider = BedrockApiKeyProvider()
            result = self._run(provider.generate(b"fake-image-bytes", "image/jpeg"))

        assert result["title"] == VALID_METADATA["title"]
        assert result["category"] == "sports"
        mock_client.chat.completions.create.assert_called_once()

    @patch("providers.bedrock_provider.AsyncOpenAI")
    def test_generate_throttle_then_success(self, mock_openai_cls):
        import openai as oai
        payload = json.dumps(VALID_METADATA)
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[
                oai.RateLimitError("rate limited", response=MagicMock(), body={}),
                _make_chat_completion(payload),
            ]
        )
        mock_openai_cls.return_value = mock_client

        import config as cfg
        with patch.object(cfg, "BEDROCK_API_KEY", "test-key"), \
             patch.object(cfg, "BEDROCK_REGION", "us-east-1"), \
             patch("providers.bedrock_provider.asyncio.sleep", new_callable=AsyncMock):
            from providers.bedrock_provider import BedrockApiKeyProvider
            provider = BedrockApiKeyProvider()
            result = self._run(provider.generate(b"fake-image-bytes", "image/jpeg"))

        assert result["title"] == VALID_METADATA["title"]
        assert mock_client.chat.completions.create.call_count == 2

    @patch("providers.bedrock_provider.AsyncOpenAI")
    def test_generate_throttle_exhausted(self, mock_openai_cls):
        import openai as oai
        from providers.bedrock_provider import BedrockThrottleError
        rate_err = oai.RateLimitError("rate limited", response=MagicMock(), body={})
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=[rate_err, rate_err, rate_err])
        mock_openai_cls.return_value = mock_client

        import config as cfg
        with patch.object(cfg, "BEDROCK_API_KEY", "test-key"), \
             patch.object(cfg, "BEDROCK_REGION", "us-east-1"), \
             patch("providers.bedrock_provider.asyncio.sleep", new_callable=AsyncMock):
            from providers.bedrock_provider import BedrockApiKeyProvider
            provider = BedrockApiKeyProvider()
            with self.assertRaises(BedrockThrottleError):
                self._run(provider.generate(b"fake-image-bytes", "image/jpeg"))

    @patch("providers.bedrock_provider.AsyncOpenAI")
    def test_generate_auth_error(self, mock_openai_cls):
        import openai as oai
        from providers.bedrock_provider import BedrockClientError
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=oai.AuthenticationError("bad key", response=MagicMock(), body={})
        )
        mock_openai_cls.return_value = mock_client

        import config as cfg
        with patch.object(cfg, "BEDROCK_API_KEY", "test-key"), \
             patch.object(cfg, "BEDROCK_REGION", "us-east-1"):
            from providers.bedrock_provider import BedrockApiKeyProvider
            provider = BedrockApiKeyProvider()
            with self.assertRaises(BedrockClientError):
                self._run(provider.generate(b"fake-image-bytes", "image/jpeg"))

    @patch("providers.bedrock_provider.AsyncOpenAI")
    def test_generate_invalid_json_response(self, mock_openai_cls):
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            return_value=_make_chat_completion("not valid json {{")
        )
        mock_openai_cls.return_value = mock_client

        import config as cfg
        with patch.object(cfg, "BEDROCK_API_KEY", "test-key"), \
             patch.object(cfg, "BEDROCK_REGION", "us-east-1"):
            from providers.bedrock_provider import BedrockApiKeyProvider
            provider = BedrockApiKeyProvider()
            with self.assertRaises(json.JSONDecodeError):
                self._run(provider.generate(b"fake-image-bytes", "image/png"))

    @patch("providers.bedrock_provider.AsyncOpenAI")
    def test_generate_unknown_mime_falls_back_to_jpeg(self, mock_openai_cls):
        payload = json.dumps(VALID_METADATA)
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            return_value=_make_chat_completion(payload)
        )
        mock_openai_cls.return_value = mock_client

        import config as cfg
        with patch.object(cfg, "BEDROCK_API_KEY", "test-key"), \
             patch.object(cfg, "BEDROCK_REGION", "us-east-1"):
            from providers.bedrock_provider import BedrockApiKeyProvider
            provider = BedrockApiKeyProvider()
            self._run(provider.generate(b"fake-image-bytes", "image/bmp"))

        call_kwargs = mock_client.chat.completions.create.call_args[1]
        image_content = call_kwargs["messages"][1]["content"][0]
        assert "image/jpeg" in image_content["image_url"]["url"]


# ── Health check tests ─────────────────────────────────────────────────────────

class TestBedrockApiKeyProviderHealthCheck(unittest.TestCase):
    def _run(self, coro):
        return asyncio.get_event_loop().run_until_complete(coro)

    @patch("providers.bedrock_provider.AsyncOpenAI")
    def test_health_check_ok(self, mock_openai_cls):
        mock_openai_cls.return_value = MagicMock()

        import config as cfg
        with patch.object(cfg, "BEDROCK_API_KEY", "test-key"), \
             patch.object(cfg, "BEDROCK_REGION", "us-east-1"), \
             patch.object(cfg, "BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0"):
            from providers.bedrock_provider import BedrockApiKeyProvider
            provider = BedrockApiKeyProvider()
            result = self._run(provider.health_check())

        assert result["status"] == "ok"
        assert result["auth"] == "api-key"
        assert "model_id" in result
        assert "region" in result

    @patch("providers.bedrock_provider.AsyncOpenAI")
    def test_health_check_no_api_key(self, mock_openai_cls):
        mock_openai_cls.return_value = MagicMock()

        import config as cfg
        with patch.object(cfg, "BEDROCK_API_KEY", ""), \
             patch.object(cfg, "BEDROCK_REGION", "us-east-1"), \
             patch.object(cfg, "BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0"):
            from providers.bedrock_provider import BedrockApiKeyProvider
            provider = BedrockApiKeyProvider()
            result = self._run(provider.health_check())

        assert result["status"] == "degraded"
        assert "error" in result


# ── Health endpoint shape test ─────────────────────────────────────────────────

def test_health_response_shape():
    health = {"status": "ok", "service": "fanvault-ai-service"}
    assert health["status"] == "ok"
    assert health["service"] == "fanvault-ai-service"
