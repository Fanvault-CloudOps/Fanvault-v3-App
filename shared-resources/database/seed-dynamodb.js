#!/usr/bin/env node
/**
 * FanVault v2 — DynamoDB Initial Seed Script
 * =====================================================
 * Run this ONCE to populate an empty DynamoDB instance with initial demo data.
 *
 * Usage:
 *   cd fanvault-v2-mono/shared-resources/database
 *   npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb bcryptjs uuid dotenv
 *   AWS_REGION=us-east-1 node seed-dynamodb.js
 *
 * Note: If you have already applied Terraform, the table names are:
 *   fanvault-users, fanvault-profiles, fanvault-products, fanvault-orders
 */

require('dotenv').config();
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const TABLES = {
  users:    process.env.DYNAMODB_TABLE_USERS    || 'fanvault-users',
  profiles: process.env.DYNAMODB_TABLE_PROFILES || 'fanvault-profiles',
  products: process.env.DYNAMODB_TABLE_PRODUCTS || 'fanvault-products',
  orders:   process.env.DYNAMODB_TABLE_ORDERS   || 'fanvault-orders',
};

const rawClient = new DynamoDBClient({ region: AWS_REGION });
const client    = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});

/** Write items to DynamoDB in chunks of 25 */
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
      console.warn(`  ⚠️  ${unprocessed.length} unprocessed items, retrying...`);
      await new Promise((r) => setTimeout(r, 1000));
      await client.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: unprocessed } })
      );
    }
    written += chunk.length;
    process.stdout.write(`\r  Written: ${written}/${items.length}`);
  }
  console.log('');
}

async function seed() {
  console.log('='.repeat(60));
  console.log('  FanVault v2 — DynamoDB Seed');
  console.log(`  Region  : ${AWS_REGION}`);
  console.log(`  Tables  : ${JSON.stringify(TABLES, null, 2)}`);
  console.log('='.repeat(60));

  const now = new Date().toISOString();

  // ── 1. Auth Users ────────────────────────────────────────────────────────
  const adminId = uuidv4();
  const demoId  = uuidv4();

  const adminHash = await bcrypt.hash('Admin@12345', 12);
  const userHash  = await bcrypt.hash('User@12345',  12);

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

  console.log(`\n[1/3] Seeding ${users.length} users → ${TABLES.users}`);
  await batchWrite(TABLES.users, users);

  // ── 2. User Profiles ─────────────────────────────────────────────────────
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

  console.log(`\n[2/3] Seeding ${profiles.length} profiles → ${TABLES.profiles}`);
  await batchWrite(TABLES.profiles, profiles);

  // ── 3. Products ───────────────────────────────────────────────────────────
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

  console.log(`\n[3/3] Seeding ${products.length} products → ${TABLES.products}`);
  await batchWrite(TABLES.products, products);

  console.log('\n' + '='.repeat(60));
  console.log('  ✅ DynamoDB Seeding Complete');
  console.log('  Admin login: admin@fanvault.example.com / Admin@12345');
  console.log('  Demo login:  demo@fanvault.example.com / User@12345');
  console.log('='.repeat(60));
}

seed().catch((err) => {
  console.error('\n❌ Seeding failed:', err.message);
  process.exit(1);
});
