import os

AWS_REGION: str = os.getenv("AWS_REGION", "us-east-1")
AI_PROVIDER: str = os.getenv("AI_PROVIDER", "openai")
OPENAI_API_KEY: str | None = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL_ID: str = os.getenv("OPENAI_MODEL_ID", "gpt-4o-mini")
BEDROCK_MODEL_ID: str = os.getenv("BEDROCK_MODEL_ID", "anthropic.claude-3-haiku-20240307-v1:0")
AI_TIMEOUT_S: float = float(os.getenv("AI_TIMEOUT_MS", "30000")) / 1000.0
S3_PRODUCT_IMAGES_BUCKET: str = os.getenv("S3_PRODUCT_IMAGES_BUCKET", "")
PORT: int = int(os.getenv("PORT", "8000"))
ENVIRONMENT: str = os.getenv("ENVIRONMENT", "production")
USE_SECRETS_MANAGER: bool = os.getenv("USE_SECRETS_MANAGER", "false").lower() == "true"
SECRET_ID: str = os.getenv("SECRET_ID", "fanvault-dev-app-secrets")
