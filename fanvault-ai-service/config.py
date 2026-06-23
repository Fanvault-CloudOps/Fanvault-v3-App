import os

AWS_REGION: str = os.getenv("AWS_REGION", "us-east-1")
BEDROCK_MODEL_ID: str = os.getenv("BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0")
AI_TIMEOUT_S: float = float(os.getenv("AI_TIMEOUT_MS", "30000")) / 1000.0
S3_PRODUCT_IMAGES_BUCKET: str = os.getenv("S3_PRODUCT_IMAGES_BUCKET", "")
PORT: int = int(os.getenv("PORT", "8000"))
ENVIRONMENT: str = os.getenv("ENVIRONMENT", "production")
BEDROCK_ASSUME_ROLE_ARN: str = os.getenv("BEDROCK_ASSUME_ROLE_ARN", "")
