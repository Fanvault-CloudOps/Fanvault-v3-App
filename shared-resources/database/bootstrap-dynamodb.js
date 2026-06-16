#!/usr/bin/env node
/**
 * FanVault v2/v3 — DynamoDB Table Provisioner & Seeder (Bootstrap Script)
 * =====================================================================
 * This script verifies, creates, and seeds all required DynamoDB tables.
 * Safe to run multiple times: skips tables that already exist.
 *
 * Usage:
 *   cd fanvault-v2-mono/shared-resources/database
 *   npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb bcryptjs uuid dotenv
 *   AWS_REGION=us-east-1 node bootstrap-dynamodb.js
 */

require('dotenv').config();
const {
  DynamoDBClient,
  DescribeTableCommand,
  CreateTableCommand,
  UpdateTimeToLiveCommand
} = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = process.env.PROJECT_NAME || 'fanvault';

const TABLES = {
  users:     process.env.DYNAMODB_TABLE_USERS      || `${PREFIX}-users`,
  profiles:  process.env.DYNAMODB_TABLE_PROFILES   || `${PREFIX}-profiles`,
  products:  process.env.DYNAMODB_TABLE_PRODUCTS   || `${PREFIX}-products`,
  orders:    process.env.DYNAMODB_TABLE_ORDERS     || `${PREFIX}-orders`,
  auditLogs: process.env.DYNAMODB_TABLE_AUDIT_LOGS || `${PREFIX}-audit-logs`,
  metadata:  process.env.DYNAMODB_TABLE_METADATA   || `${PREFIX}-metadata`,
};

const rawClient = new DynamoDBClient({ region: AWS_REGION });
const client    = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});

// Helper to check if table exists
async function tableExists(tableName) {
  try {
    await rawClient.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return false;
    }
    throw err;
  }
}

// Helper to wait until table is ACTIVE
async function waitForTableActive(tableName) {
  process.stdout.write(`  Waiting for ${tableName} to become ACTIVE...`);
  for (let i = 0; i < 30; i++) {
    try {
      const response = await rawClient.send(new DescribeTableCommand({ TableName: tableName }));
      const status = response.Table?.TableStatus;
      if (status === 'ACTIVE') {
        console.log(' ACTIVE! ✅');
        return;
      }
    } catch (err) {
      // Ignored during intermediate state
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(' Timed out ❌');
  throw new Error(`Table ${tableName} did not reach ACTIVE state in time.`);
}

// Helper to batch-write items in chunks of 25
async function batchWrite(tableName, items) {
  if (items.length === 0) return;
  const chunks = [];
  for (let i = 0; i < items.length; i += 25) {
    chunks.push(items.slice(i, i + 25));
  }

  let written = 0;
  for (const chunk of chunks) {
    const requests = chunk.map((item) => ({ PutRequest: { Item: item } }));
    const response = await client.send(
      new BatchWriteCommand({ RequestItems: { [tableName]: requests } })
    );

    const unprocessed = response.UnprocessedItems?.[tableName] || [];
    if (unprocessed.length > 0) {
      await new Promise((r) => setTimeout(r, 1000));
      await client.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: unprocessed } })
      );
    }
    written += chunk.length;
  }
  console.log(`  Seeded ${written} items into ${tableName}`);
}

async function bootstrap() {
  console.log('='.repeat(60));
  console.log('  FanVault v3 — DynamoDB Bootstrap');
  console.log(`  Region  : ${AWS_REGION}`);
  console.log('='.repeat(60));

  // ── 1. Create Tables if they don't exist ────────────────────────────────────

  // Table 1: Users
  if (!(await tableExists(TABLES.users))) {
    console.log(`Creating table: ${TABLES.users}`);
    await rawClient.send(new CreateTableCommand({
      TableName: TABLES.users,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'email', AttributeType: 'S' }
      ],
      GlobalSecondaryIndexes: [{
        IndexName: 'email-index',
        KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' }
      }]
    }));
    await waitForTableActive(TABLES.users);
  } else {
    console.log(`Table exists: ${TABLES.users}`);
  }

  // Table 2: Profiles
  if (!(await tableExists(TABLES.profiles))) {
    console.log(`Creating table: ${TABLES.profiles}`);
    await rawClient.send(new CreateTableCommand({
      TableName: TABLES.profiles,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }]
    }));
    await waitForTableActive(TABLES.profiles);
  } else {
    console.log(`Table exists: ${TABLES.profiles}`);
  }

  // Table 3: Products
  if (!(await tableExists(TABLES.products))) {
    console.log(`Creating table: ${TABLES.products}`);
    await rawClient.send(new CreateTableCommand({
      TableName: TABLES.products,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'productId', KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: 'productId', AttributeType: 'S' },
        { AttributeName: 'sku', AttributeType: 'S' },
        { AttributeName: 'category', AttributeType: 'S' },
        { AttributeName: 'franchise', AttributeType: 'S' }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'sku-index',
          KeySchema: [{ AttributeName: 'sku', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' }
        },
        {
          IndexName: 'category-franchise-index',
          KeySchema: [
            { AttributeName: 'category', KeyType: 'HASH' },
            { AttributeName: 'franchise', KeyType: 'RANGE' }
          ],
          Projection: { ProjectionType: 'ALL' }
        }
      ]
    }));
    await waitForTableActive(TABLES.products);
  } else {
    console.log(`Table exists: ${TABLES.products}`);
  }

  // Table 4: Orders
  if (!(await tableExists(TABLES.orders))) {
    console.log(`Creating table: ${TABLES.orders}`);
    await rawClient.send(new CreateTableCommand({
      TableName: TABLES.orders,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: 'orderId', AttributeType: 'S' },
        { AttributeName: 'orderNumber', AttributeType: 'S' },
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'status', AttributeType: 'S' },
        { AttributeName: 'createdAt', AttributeType: 'S' }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'userId-createdAt-index',
          KeySchema: [
            { AttributeName: 'userId', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' }
          ],
          Projection: { ProjectionType: 'ALL' }
        },
        {
          IndexName: 'orderNumber-index',
          KeySchema: [{ AttributeName: 'orderNumber', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' }
        },
        {
          IndexName: 'status-createdAt-index',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' }
          ],
          Projection: { ProjectionType: 'ALL' }
        }
      ]
    }));
    await waitForTableActive(TABLES.orders);
  } else {
    console.log(`Table exists: ${TABLES.orders}`);
  }

  // Table 5: Audit Logs
  if (!(await tableExists(TABLES.auditLogs))) {
    console.log(`Creating table: ${TABLES.auditLogs}`);
    await rawClient.send(new CreateTableCommand({
      TableName: TABLES.auditLogs,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'logId', KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: 'logId', AttributeType: 'S' },
        { AttributeName: 'entityType', AttributeType: 'S' },
        { AttributeName: 'adminId', AttributeType: 'S' },
        { AttributeName: 'timestamp', AttributeType: 'S' }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'entityType-timestamp-index',
          KeySchema: [
            { AttributeName: 'entityType', KeyType: 'HASH' },
            { AttributeName: 'timestamp', KeyType: 'RANGE' }
          ],
          Projection: { ProjectionType: 'ALL' }
        },
        {
          IndexName: 'adminId-timestamp-index',
          KeySchema: [
            { AttributeName: 'adminId', KeyType: 'HASH' },
            { AttributeName: 'timestamp', KeyType: 'RANGE' }
          ],
          Projection: { ProjectionType: 'ALL' }
        }
      ]
    }));
    await waitForTableActive(TABLES.auditLogs);

    // Enable TTL
    console.log(`Enabling TTL for: ${TABLES.auditLogs}`);
    try {
      const ttlSpec = { Enabled: true, AttributeName: 'expiresAt' };
      if (!ttlSpec || !ttlSpec.AttributeName || typeof ttlSpec.Enabled !== 'boolean') {
        throw new Error('Invalid or null TimeToLiveSpecification configuration');
      }
      await rawClient.send(new UpdateTimeToLiveCommand({
        TableName: TABLES.auditLogs,
        TimeToLiveSpecification: ttlSpec
      }));
      console.log('  TTL configuration enabled successfully. ✅');
    } catch (ttlErr) {
      if (
        ttlErr.name === 'ValidationException' &&
        (ttlErr.message.includes('already enabled') || ttlErr.message.includes('TimeToLive'))
      ) {
        console.log('  TTL is already enabled or already being configured on this table. (Gracefully continued) ✅');
      } else {
        console.warn(`  ⚠️ Failed to enable TTL: ${ttlErr.message}. (Continuing bootstrap anyway)`);
      }
    }
  } else {
    console.log(`Table exists: ${TABLES.auditLogs}`);
  }

  // Table 6: Metadata
  if (!(await tableExists(TABLES.metadata))) {
    console.log(`Creating table: ${TABLES.metadata}`);
    await rawClient.send(new CreateTableCommand({
      TableName: TABLES.metadata,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'metaType', KeyType: 'HASH' },
        { AttributeName: 'metaId', KeyType: 'RANGE' }
      ],
      AttributeDefinitions: [
        { AttributeName: 'metaType', AttributeType: 'S' },
        { AttributeName: 'metaId', AttributeType: 'S' }
      ]
    }));
    await waitForTableActive(TABLES.metadata);
  } else {
    console.log(`Table exists: ${TABLES.metadata}`);
  }

  // ── 2. Seeding Initial Demo Data ───────────────────────────────────────────
  console.log('\nStarting database seeding...');

  const now = new Date().toISOString();
  const adminId = uuidv4();
  const demoId  = uuidv4();

  const adminHash = await bcrypt.hash('Admin@12345', 12);
  const userHash  = await bcrypt.hash('User@12345',  12);

  // Check if users exist before seeding to prevent overwriting
  const userCheck = await rawClient.send(new DescribeTableCommand({ TableName: TABLES.users }));
  if (userCheck.Table.ItemCount === 0) {
    // 2.1 Seed Users
    const users = [
      {
        userId:       adminId,
        email:        'admin@fanvault.example.com',
        passwordHash: adminHash,
        role:         'admin',
        isActive:     true,
        createdAt:    now,
        updatedAt:    now,
      },
      {
        userId:       demoId,
        email:        'demo@fanvault.example.com',
        passwordHash: userHash,
        role:         'user',
        isActive:     true,
        createdAt:    now,
        updatedAt:    now,
      }
    ];
    await batchWrite(TABLES.users, users);

    // 2.2 Seed Profiles
    const profiles = [
      {
        userId:      adminId,
        email:       'admin@fanvault.example.com',
        firstName:   'Platform',
        lastName:    'Admin',
        addresses:   [],
        preferences: { newsletter: false, smsAlerts: false },
        createdAt:   now,
        updatedAt:   now,
      },
      {
        userId:      demoId,
        email:       'demo@fanvault.example.com',
        firstName:   'Demo',
        lastName:    'User',
        addresses: [
          {
            addressId:  uuidv4(),
            line1:      '42 MG Road',
            city:       'Bengaluru',
            state:      'Karnataka',
            postalCode: '560001',
            country:    'India',
            isDefault:  true,
          }
        ],
        preferences: { newsletter: true, smsAlerts: false },
        createdAt:   now,
        updatedAt:   now,
      }
    ];
    await batchWrite(TABLES.profiles, profiles);

    // 2.3 Seed Products
    const products = [
      {
        productId:    uuidv4(),
        name:         'Mumbai Indians Jersey 2024',
        description:  'Official IPL jersey for the Mumbai Indians. Made from breathable polyester.',
        price:        1299,
        comparePrice: 1599,
        category:     'clothing',
        franchise:    'Mumbai Indians',
        franchiseType:'sports',
        tags:         ['ipl', 'cricket', 'jersey', 'mumbai'],
        images:       ['/api/products/images/mi-jersey-2024.jpg'],
        sku:          'MI-JERSEY-2024-S',
        stock:        120,
        sizes:        ['S', 'M', 'L', 'XL', 'XXL'],
        colors:       ['Blue', 'Gold'],
        rating:       { average: 4.6, count: 284 },
        isActive:     true,
        createdAt:    now,
        updatedAt:    now,
      },
      {
        productId:    uuidv4(),
        name:         'RCB Cap — Classic Edition',
        description:  'Royal Challengers Bangalore cap with embroidered logo.',
        price:        599,
        comparePrice: 799,
        category:     'accessories',
        franchise:    'Royal Challengers Bangalore',
        franchiseType:'sports',
        tags:         ['rcb', 'cap', 'cricket', 'ipl'],
        images:       ['/api/products/images/rcb-cap-classic.jpg'],
        sku:          'RCB-CAP-CLS-001',
        stock:        75,
        sizes:        ['Free Size'],
        colors:       ['Red', 'Black'],
        rating:       { average: 4.3, count: 157 },
        isActive:     true,
        createdAt:    now,
        updatedAt:    now,
      },
      {
        productId:    uuidv4(),
        name:         'Avengers Infinity War Hoodie',
        description:  'Premium cotton-blend hoodie featuring the Avengers ensemble artwork.',
        price:        1899,
        comparePrice: 2499,
        category:     'clothing',
        franchise:    'Marvel Avengers',
        franchiseType:'movie',
        tags:         ['marvel', 'avengers', 'hoodie', 'superhero'],
        images:       ['/api/products/images/avengers-infinity-hoodie.jpg'],
        sku:          'MARVEL-AVNG-HOOD-M',
        stock:        45,
        sizes:        ['S', 'M', 'L', 'XL'],
        colors:       ['Charcoal', 'Navy'],
        rating:       { average: 4.7, count: 392 },
        isActive:     true,
        createdAt:    now,
        updatedAt:    now,
      },
      {
        productId:    uuidv4(),
        name:         'Breaking Bad Heisenberg Tee',
        description:  'Classic black Heisenberg silhouette t-shirt from Breaking Bad.',
        price:        799,
        comparePrice: 999,
        category:     'clothing',
        franchise:    'Breaking Bad',
        franchiseType:'show',
        tags:         ['breaking-bad', 'heisenberg', 'tshirt', 'series'],
        images:       ['/api/products/images/breaking-bad-heisenberg-tee.jpg'],
        sku:          'BB-HSNBG-TEE-L',
        stock:        60,
        sizes:        ['S', 'M', 'L', 'XL', 'XXL'],
        colors:       ['Black'],
        rating:       { average: 4.8, count: 210 },
        isActive:     true,
        createdAt:    now,
        updatedAt:    now,
      },
      {
        productId:    uuidv4(),
        name:         'Chelsea FC Sneakers',
        description:  'Limited-edition Chelsea Football Club co-branded sneakers.',
        price:        3499,
        comparePrice: 4299,
        category:     'shoes',
        franchise:    'Chelsea FC',
        franchiseType:'sports',
        tags:         ['chelsea', 'football', 'soccer', 'sneakers', 'premier-league'],
        images:       ['/api/products/images/chelsea-fc-sneakers.jpg'],
        sku:          'CFC-SNKR-BLU-42',
        stock:        30,
        sizes:        ['UK7', 'UK8', 'UK9', 'UK10', 'UK11'],
        colors:       ['Blue', 'White'],
        rating:       { average: 4.5, count: 88 },
        isActive:     true,
        createdAt:    now,
        updatedAt:    now,
      }
    ];
    await batchWrite(TABLES.products, products);

    // 2.4 Seed Metadata
    const metadata = [
      { metaType: 'category', metaId: 'clothing', displayName: 'Clothing', isActive: true, createdAt: now, updatedAt: now },
      { metaType: 'category', metaId: 'accessories', displayName: 'Accessories', isActive: true, createdAt: now, updatedAt: now },
      { metaType: 'category', metaId: 'shoes', displayName: 'Shoes', isActive: true, createdAt: now, updatedAt: now },
      { metaType: 'franchise', metaId: 'mumbai-indians', displayName: 'Mumbai Indians', franchiseType: 'sports', isActive: true, createdAt: now, updatedAt: now },
      { metaType: 'franchise', metaId: 'royal-challengers-bangalore', displayName: 'Royal Challengers Bangalore', franchiseType: 'sports', isActive: true, createdAt: now, updatedAt: now },
      { metaType: 'franchise', metaId: 'marvel-avengers', displayName: 'Marvel Avengers', franchiseType: 'movie', isActive: true, createdAt: now, updatedAt: now },
      { metaType: 'franchise', metaId: 'breaking-bad', displayName: 'Breaking Bad', franchiseType: 'show', isActive: true, createdAt: now, updatedAt: now },
      { metaType: 'franchise', metaId: 'chelsea-fc', displayName: 'Chelsea FC', franchiseType: 'sports', isActive: true, createdAt: now, updatedAt: now },
    ];
    await batchWrite(TABLES.metadata, metadata);
  } else {
    console.log('Tables already seeded. Skipping seeding stage.');
  }

  console.log('\n' + '='.repeat(60));
  console.log('  🎉 DynamoDB Bootstrap & Seed Complete!');
  console.log('  Admin User: admin@fanvault.example.com / Admin@12345');
  console.log('  Demo User : demo@fanvault.example.com / User@12345');
  console.log('='.repeat(60));
}

bootstrap().catch((err) => {
  console.error('\n❌ Bootstrap failed:', err.stack);
  process.exit(1);
});
