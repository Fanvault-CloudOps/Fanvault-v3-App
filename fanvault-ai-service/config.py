import json
import logging
import os

import boto3

logger = logging.getLogger(__name__)

AWS_REGION: str = os.getenv("AWS_REGION", "us-east-1")
BEDROCK_REGION: str = os.getenv("BEDROCK_REGION", AWS_REGION)
BEDROCK_MODEL_ID: str = os.getenv("BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0")
AI_TIMEOUT_S: float = float(os.getenv("AI_TIMEOUT_MS", "30000")) / 1000.0
S3_PRODUCT_IMAGES_BUCKET: str = os.getenv("S3_PRODUCT_IMAGES_BUCKET", "")
PORT: int = int(os.getenv("PORT", "8000"))
ENVIRONMENT: str = os.getenv("ENVIRONMENT", "production")
SECRET_ID: str = os.getenv("SECRET_ID", "")


def _fetch_api_key_from_secrets_manager() -> str:
    if not SECRET_ID:
        return ""
    try:
        sm = boto3.client("secretsmanager", region_name=AWS_REGION)
        payload = json.loads(sm.get_secret_value(SecretId=SECRET_ID)["SecretString"])
        return payload.get("BEDROCK_API_KEY", "")
    except Exception as exc:
        logger.warning("secrets-manager fetch failed (BEDROCK_API_KEY will be absent): %s", exc)
        return ""


BEDROCK_API_KEY: str = os.getenv("BEDROCK_API_KEY") or _fetch_api_key_from_secrets_manager()


def validate_config() -> None:
    errors = []
    if not BEDROCK_API_KEY:
        errors.append("BEDROCK_API_KEY is required (set env var or add to Secrets Manager via SECRET_ID)")
    if not BEDROCK_REGION:
        errors.append("BEDROCK_REGION is required")
    if not BEDROCK_MODEL_ID:
        errors.append("BEDROCK_MODEL_ID is required")
    if errors:
        raise RuntimeError(f"AI service misconfigured: {'; '.join(errors)}")
