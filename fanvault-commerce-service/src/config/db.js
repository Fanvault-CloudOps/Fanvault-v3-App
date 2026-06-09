const { DynamoDBClient, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

// ── Singleton DynamoDB Document Client ───────────────────────────────────────
let docClient = null;

function getDocClient() {
  if (!docClient) {
    throw new Error('[db] DynamoDB client not initialised. Call initDynamoDB() first.');
  }
  return docClient;
}

// ── Initialise DynamoDB + optionally load JWT secret from Secrets Manager ────
async function initDynamoDB() {
  const region = process.env.AWS_REGION || 'us-east-1';

  const rawClient = new DynamoDBClient({ region });
  docClient = DynamoDBDocumentClient.from(rawClient, {
    marshallOptions: {
      removeUndefinedValues: true,
      convertClassInstanceToMap: true,
    },
  });

  // Optional: load JWT_SECRET from Secrets Manager in production
  const useSecretsManager =
    process.env.USE_SECRETS_MANAGER === 'true' || process.env.NODE_ENV === 'production';

  if (useSecretsManager) {
    const secretId = process.env.SECRET_ID || 'production/fanvault-auth';
    console.log(`[db] Fetching JWT secret from Secrets Manager (${secretId})...`);
    try {
      const smClient = new SecretsManagerClient({ region });
      const response = await smClient.send(
        new GetSecretValueCommand({ SecretId: secretId })
      );
      const secret = JSON.parse(response.SecretString);
      if (secret.jwtSecret) process.env.JWT_SECRET = secret.jwtSecret;
      console.log('[db] JWT secret loaded from Secrets Manager.');
    } catch (err) {
      console.warn('[db] Could not fetch from Secrets Manager, using .env values:', err.message);
    }
  }

  // Health-check: confirm the products table is reachable
  const productsTable = process.env.DYNAMODB_TABLE_PRODUCTS || 'fanvault-products';
  try {
    await docClient.send(new DescribeTableCommand({ TableName: productsTable }));
    console.log(`✅ DynamoDB connected — table "${productsTable}" is accessible.`);
  } catch (err) {
    console.error(`❌ DynamoDB health-check failed for table "${productsTable}":`, err.message);
    throw err;
  }
}

module.exports = { initDynamoDB, getDocClient };
