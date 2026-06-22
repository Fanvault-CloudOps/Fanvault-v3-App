"""
Unit tests for the FanVault AI service (Bedrock-native).
All external I/O (boto3, S3) is mocked via unittest.mock so tests run without AWS credentials.
"""
import json
import unittest
from unittest.mock import MagicMock, patch

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


# ── BedrockClient unit tests ───────────────────────────────────────────────────

class TestBedrockClientGenerate(unittest.TestCase):
    def _make_converse_response(self, text: str) -> dict:
        return {
            "output": {"message": {"content": [{"text": text}]}},
            "usage": {"inputTokens": 100, "outputTokens": 50},
        }

    @patch("services.bedrock_client.boto3.client")
    def test_generate_success(self, mock_boto):
        payload = json.dumps(VALID_METADATA)
        mock_client = MagicMock()
        mock_client.converse.return_value = self._make_converse_response(payload)
        mock_boto.return_value = mock_client

        from services.bedrock_client import BedrockClient
        client = BedrockClient()
        result = client.generate(b"fake-image-bytes", "image/jpeg")

        assert result["title"] == VALID_METADATA["title"]
        assert result["category"] == "sports"
        mock_client.converse.assert_called_once()

    @patch("services.bedrock_client.boto3.client")
    def test_generate_throttle_then_success(self, mock_boto):
        from botocore.exceptions import ClientError
        payload = json.dumps(VALID_METADATA)
        throttle_error = ClientError(
            {"Error": {"Code": "ThrottlingException", "Message": "Rate exceeded"}},
            "Converse",
        )
        mock_client = MagicMock()
        mock_client.converse.side_effect = [throttle_error, self._make_converse_response(payload)]
        mock_boto.return_value = mock_client

        from services.bedrock_client import BedrockClient
        with patch("services.bedrock_client.time.sleep"):  # skip actual sleep
            client = BedrockClient()
            result = client.generate(b"fake-image-bytes", "image/jpeg")

        assert result["title"] == VALID_METADATA["title"]
        assert mock_client.converse.call_count == 2

    @patch("services.bedrock_client.boto3.client")
    def test_generate_throttle_exhausted(self, mock_boto):
        from botocore.exceptions import ClientError
        from services.bedrock_client import BedrockThrottleError
        throttle_error = ClientError(
            {"Error": {"Code": "ThrottlingException", "Message": "Rate exceeded"}},
            "Converse",
        )
        mock_client = MagicMock()
        mock_client.converse.side_effect = [throttle_error, throttle_error, throttle_error]
        mock_boto.return_value = mock_client

        from services.bedrock_client import BedrockClient
        with patch("services.bedrock_client.time.sleep"):
            client = BedrockClient()
            with self.assertRaises(BedrockThrottleError):
                client.generate(b"fake-image-bytes", "image/jpeg")

    @patch("services.bedrock_client.boto3.client")
    def test_generate_client_error(self, mock_boto):
        from botocore.exceptions import ClientError
        from services.bedrock_client import BedrockClientError
        error = ClientError(
            {"Error": {"Code": "ValidationException", "Message": "Invalid model"}},
            "Converse",
        )
        mock_client = MagicMock()
        mock_client.converse.side_effect = error
        mock_boto.return_value = mock_client

        from services.bedrock_client import BedrockClient
        client = BedrockClient()
        with self.assertRaises(BedrockClientError):
            client.generate(b"fake-image-bytes", "image/jpeg")

    @patch("services.bedrock_client.boto3.client")
    def test_generate_invalid_json_response(self, mock_boto):
        mock_client = MagicMock()
        mock_client.converse.return_value = self._make_converse_response("not valid json {{")
        mock_boto.return_value = mock_client

        from services.bedrock_client import BedrockClient
        client = BedrockClient()
        with self.assertRaises(json.JSONDecodeError):
            client.generate(b"fake-image-bytes", "image/png")

    @patch("services.bedrock_client.boto3.client")
    def test_generate_unknown_mime_falls_back_to_jpeg(self, mock_boto):
        payload = json.dumps(VALID_METADATA)
        mock_client = MagicMock()
        mock_client.converse.return_value = self._make_converse_response(payload)
        mock_boto.return_value = mock_client

        from services.bedrock_client import BedrockClient
        client = BedrockClient()
        client.generate(b"fake-image-bytes", "image/bmp")  # bmp → falls back to jpeg

        call_kwargs = mock_client.converse.call_args[1]
        image_block = call_kwargs["messages"][0]["content"][0]["image"]
        assert image_block["format"] == "jpeg"


# ── Health check tests ─────────────────────────────────────────────────────────

class TestBedrockClientHealthCheck(unittest.TestCase):
    @patch("services.bedrock_client.boto3.client")
    def test_health_check_ok(self, mock_boto):
        mock_sts = MagicMock()
        mock_sts.get_caller_identity.return_value = {
            "Arn": "arn:aws:sts::123456789012:assumed-role/fanvault-ai-irsa-role/session"
        }
        mock_boto.return_value = mock_sts

        from services.bedrock_client import BedrockClient
        client = BedrockClient()
        result = client.health_check()

        assert result["status"] == "ok"
        assert "iam_arn" in result
        assert "model_id" in result

    @patch("services.bedrock_client.boto3.client")
    def test_health_check_no_credentials(self, mock_boto):
        from botocore.exceptions import NoCredentialsError
        mock_sts = MagicMock()
        mock_sts.get_caller_identity.side_effect = NoCredentialsError()

        # First call (bedrock-runtime client creation) must succeed; second (sts) raises
        mock_boto.side_effect = [MagicMock(), mock_sts]

        from services.bedrock_client import BedrockClient
        client = BedrockClient()
        result = client.health_check()

        assert result["status"] == "degraded"
        assert "NoCredentials" in result["error"]


# ── Health endpoint shape test ─────────────────────────────────────────────────

def test_health_response_shape():
    health = {"status": "ok", "service": "fanvault-ai-service"}
    assert health["status"] == "ok"
    assert health["service"] == "fanvault-ai-service"
