#!/usr/bin/env node
/**
 * FanVault v2 — MongoDB to DynamoDB Migration Script
 * =====================================================
 * Run this ONCE on a machine that has:
 *   1. Access to the MongoDB instance (via mongoexport or direct connection)
 *   2. AWS credentials with dynamodb:PutItem, dynamodb:BatchWriteItem permissions
 *
 * Usage:
 *   node migrate-to-dynamodb.js
 *
 * Prerequisites:
 *   npm install @aws-sdk/lib-dynamodb @aws-sdk/client-dynamodb mongoose dotenv uuid
 *
 * Steps:
 *   1. Export MongoDB collections to JSON files (see commands below)
 *   2. Set env vars (AWS_REGION, MONGO_URI, DYNAMODB_TABLE_* )
 *   3. Run this script
 *
 * Export commands (run on the MongoDB EC2 or locally via SSH tunnel):
 *   mongoexport --uri "$MONGO_URI" --collection authusers   --out authusers.json   --jsonArray
 *   mongoexport --uri "$MONGO_URI" --collection userprofiles --out userprofiles.json --jsonArray
 *   mongoexport --uri "$MONGO_URI" --collection products     --out products.json     --jsonArray
 *   mongoexport --uri "$MONGO_URI" --collection orders       --out orders.json       --jsonArray
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { DynamoDBClient }        = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert MongoDB _id ($oid) to a plain string */
function mongoId(id) {
  if (!id) return null;
  return typeof id === 'object' ? id.$oid || String(id) : String(id);
}

/** Convert MongoDB $date to ISO 8601 string */
function mongoDate(d) {
  if (!d) return new Date().toISOString();
  if (typeof d === 'string') return d;
  return new Date(d.$date ?? d).toISOString();
}

/** Write items to DynamoDB in chunks of 25 (BatchWriteItem limit) */
async function batchWrite(tableName, items) {
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

    // Handle unprocessed items (retry once)
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

/** Load a JSON export file */
function loadJson(filename) {
  const p = path.join(__dirname, filename);
  if (!fs.existsSync(p)) {
    console.warn(`  ⚠️  File not found: ${filename} — skipping.`);
    return [];
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// ── Collection Mappers ────────────────────────────────────────────────────────

/** Map authusers MongoDB doc → fanvault-users DynamoDB item */
function mapUser(doc) {
  return {
    userId:       mongoId(doc._id),
    email:        (doc.email || '').toLowerCase().trim(),
    passwordHash: doc.password || doc.passwordHash || '',
    role:         doc.role      || 'user',
    isActive:     doc.isActive  !== false,
    lastLogin:    doc.lastLogin ? mongoDate(doc.lastLogin) : null,
    createdAt:    mongoDate(doc.createdAt),
    updatedAt:    mongoDate(doc.updatedAt),
  };
}

/** Map userprofiles MongoDB doc → fanvault-profiles DynamoDB item */
function mapProfile(doc) {
  const addresses = (doc.addresses || []).map((addr) => ({
    addressId:  require('uuid').v4(), // Assign stable ID for deletion support
    line1:      addr.line1      || '',
    line2:      addr.line2      || null,
    city:       addr.city       || '',
    state:      addr.state      || '',
    postalCode: addr.postalCode || '',
    country:    addr.country    || 'India',
    isDefault:  addr.isDefault  || false,
  }));

  return {
    userId:      mongoId(doc.authId) || mongoId(doc._id),
    email:       (doc.email || '').toLowerCase().trim(),
    firstName:   doc.firstName   || null,
    lastName:    doc.lastName    || null,
    phone:       doc.phone       || null,
    avatar:      doc.avatar      || null,
    addresses,
    preferences: doc.preferences || { newsletter: true, smsAlerts: false },
    createdAt:   mongoDate(doc.createdAt),
    updatedAt:   mongoDate(doc.updatedAt),
  };
}

/** Map products MongoDB doc → fanvault-products DynamoDB item */
function mapProduct(doc) {
  return {
    productId:     mongoId(doc._id),
    name:          doc.name          || '',
    description:   doc.description   || '',
    price:         Number(doc.price  || 0),
    comparePrice:  doc.comparePrice  ? Number(doc.comparePrice) : null,
    category:      doc.category      || 'accessories',
    franchise:     doc.franchise     || '',
    franchiseType: doc.franchiseType || 'sports',
    tags:          doc.tags          || [],
    images:        doc.images        || [],
    sku:           doc.sku           || mongoId(doc._id),
    stock:         Number(doc.stock  || 0),
    sizes:         doc.sizes         || [],
    colors:        doc.colors        || [],
    rating:        doc.rating        || { average: 0, count: 0 },
    isActive:      doc.isActive      !== false,
    createdAt:     mongoDate(doc.createdAt),
    updatedAt:     mongoDate(doc.updatedAt),
  };
}

/** Map orders MongoDB doc → fanvault-orders DynamoDB item */
function mapOrder(doc) {
  const items = (doc.items || []).map((item) => ({
    productId: mongoId(item.productId) || item.productId,
    name:      item.name     || '',
    price:     Number(item.price    || 0),
    quantity:  Number(item.quantity || 1),
    image:     item.image  || null,
    size:      item.size   || null,
    color:     item.color  || null,
  }));

  return {
    orderId:          mongoId(doc._id),
    orderNumber:      doc.orderNumber || `FAN-MIGRATED-${mongoId(doc._id).slice(-8)}`,
    userId:           mongoId(doc.userId) || doc.userId,
    userEmail:        doc.userEmail       || '',
    items,
    shippingAddress:  doc.shippingAddress || {},
    subtotal:         Number(doc.subtotal    || 0),
    shippingCost:     Number(doc.shippingCost || 0),
    tax:              Number(doc.tax         || 0),
    total:            Number(doc.total       || 0),
    paymentMethod:    doc.paymentMethod  || 'cod',
    paymentStatus:    doc.paymentStatus  || 'pending',
    status:           doc.status         || 'placed',
    notes:            doc.notes          || null,
    notificationSent: true,
    createdAt:        mongoDate(doc.createdAt),
    updatedAt:        mongoDate(doc.updatedAt),
  };
}

// ── Main Migration ────────────────────────────────────────────────────────────
async function migrate() {
  console.log('='.repeat(60));
  console.log('  FanVault v2 — MongoDB → DynamoDB Migration');
  console.log(`  Region  : ${AWS_REGION}`);
  console.log(`  Tables  : ${JSON.stringify(TABLES, null, 2)}`);
  console.log('='.repeat(60));

  // 1. Users
  {
    const docs  = loadJson('authusers.json');
    const items = docs.map(mapUser).filter((u) => u.userId);
    console.log(`\n[1/4] Migrating ${items.length} users → ${TABLES.users}`);
    if (items.length) await batchWrite(TABLES.users, items);
    console.log('  ✅ Users done.');
  }

  // 2. Profiles
  {
    const docs  = loadJson('userprofiles.json');
    const items = docs.map(mapProfile).filter((p) => p.userId);
    console.log(`\n[2/4] Migrating ${items.length} profiles → ${TABLES.profiles}`);
    if (items.length) await batchWrite(TABLES.profiles, items);
    console.log('  ✅ Profiles done.');
  }

  // 3. Products
  {
    const docs  = loadJson('products.json');
    const items = docs.map(mapProduct).filter((p) => p.productId);
    console.log(`\n[3/4] Migrating ${items.length} products → ${TABLES.products}`);
    if (items.length) await batchWrite(TABLES.products, items);
    console.log('  ✅ Products done.');
  }

  // 4. Orders
  {
    const docs  = loadJson('orders.json');
    const items = docs.map(mapOrder).filter((o) => o.orderId);
    console.log(`\n[4/4] Migrating ${items.length} orders → ${TABLES.orders}`);
    if (items.length) await batchWrite(TABLES.orders, items);
    console.log('  ✅ Orders done.');
  }

  console.log('\n' + '='.repeat(60));
  console.log('  Migration COMPLETE');
  console.log('  Next steps:');
  console.log('    1. Verify item counts in AWS DynamoDB Console');
  console.log('    2. Test all API endpoints against DynamoDB');
  console.log('    3. After 48h observation, decommission MongoDB EC2');
  console.log('='.repeat(60));
}

migrate().catch((err) => {
  console.error('\n❌ Migration failed:', err.message);
  process.exit(1);
});
