const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, DescribeTableCommand } = require('@aws-sdk/lib-dynamodb');
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

// ── Initialise DynamoDB + optionally load JWT secrets from Secrets Manager ───
async function initDynamoDB() {
  const region = process.env.AWS_REGION || 'us-east-1';

  // Build the Document client (handles marshalling/unmarshalling automatically)
  const rawClient = new DynamoDBClient({ region });
  docClient = DynamoDBDocumentClient.from(rawClient, {
    marshallOptions: {
      removeUndefinedValues: true, // Strip undefined fields — avoids DynamoDB validation errors
      convertClassInstanceToMap: true,
    },
  });

  // Optional: fetch JWT secrets from Secrets Manager in production
  const useSecretsManager =
    process.env.USE_SECRETS_MANAGER === 'true' || process.env.NODE_ENV === 'production';

  if (useSecretsManager) {
    const secretId = process.env.SECRET_ID || 'production/fanvault-auth';
    console.log(`[db] Fetching JWT secrets from Secrets Manager (${secretId})...`);
    try {
      const smClient = new SecretsManagerClient({ region });
      const response = await smClient.send(
        new GetSecretValueCommand({ SecretId: secretId })
      );
      const secret = JSON.parse(response.SecretString);

      if (secret.jwtSecret)        process.env.JWT_SECRET        = secret.jwtSecret;
      if (secret.jwtRefreshSecret) process.env.JWT_REFRESH_SECRET = secret.jwtRefreshSecret;

      console.log('[db] JWT secrets loaded from Secrets Manager.');
    } catch (err) {
      // Non-fatal: fallback to .env values already in process.env
      console.warn('[db] Could not fetch from Secrets Manager, using .env values:', err.message);
    }
  }

  // Health-check: confirm the users table is reachable
  const usersTable = process.env.DYNAMODB_TABLE_USERS || 'fanvault-users';
  try {
    await docClient.send(new DescribeTableCommand({ TableName: usersTable }));
    console.log(`✅ DynamoDB connected — table "${usersTable}" is accessible.`);
  } catch (err) {
    console.error(`❌ DynamoDB health-check failed for table "${usersTable}":`, err.message);
    throw err; // Fatal — crash fast on startup if DynamoDB is unreachable
  }
}

module.exports = { initDynamoDB, getDocClient };
