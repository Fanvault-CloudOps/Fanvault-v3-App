#!/usr/bin/env node
// =============================================================================
// seed-data.js — FanVault v2 Consolidated Database Seeder
//
// Run from the EC2 DB instance or any machine with MongoDB access:
//   MONGO_URI="mongodb://dbuser:password@db.fanvault.internal:27017/fanvault_db?authSource=admin" \
//   node seed-data.js
//
// WARNING: This will DROP existing data in all collections before seeding.
//          Use only for initial setup or test environment resets.
// =============================================================================
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

async function getMongoURI() {
  let uri = process.env.MONGO_URI;
  const useSecretsManager = process.env.USE_SECRETS_MANAGER === 'true';

  if (useSecretsManager) {
    const client = new SecretsManagerClient({
      region: process.env.AWS_REGION || "us-east-1"
    });
    const secretId = process.env.SECRET_ID || "production/mongodb";
    console.log(`[seed] Fetching database secret '${secretId}' from AWS Secrets Manager...`);
    try {
      const response = await client.send(
        new GetSecretValueCommand({ SecretId: secretId })
      );
      const secret = JSON.parse(response.SecretString);
      const authSource = secret.authSource || secret.database || "admin";
      uri = `mongodb://${secret.username}:${secret.password}@${secret.host}:${secret.port}/${secret.database}?authSource=${authSource}`;
      console.log(`[seed] Database URI constructed dynamically from secret.`);
    } catch (err) {
      console.error('[seed] Error retrieving secrets from Secrets Manager:', err.message);
      if (!uri) {
        throw new Error('Database connection string not configured and Secrets Manager retrieval failed.');
      }
    }
  }
  return uri;
}

// ── Inline schemas (mirror the service models exactly) ────────────────────────
const AuthUser = mongoose.model('AuthUser', new mongoose.Schema({
  email:     { type: String, required: true, unique: true, lowercase: true },
  password:  { type: String, required: true, select: false },
  role:      { type: String, enum: ['user', 'admin'], default: 'user' },
  isActive:  { type: Boolean, default: true },
  lastLogin: Date,
}, { timestamps: true }));

const UserProfile = mongoose.model('UserProfile', new mongoose.Schema({
  authId:    { type: String, required: true, unique: true },
  email:     { type: String, required: true, unique: true },
  firstName: String,
  lastName:  String,
  phone:     String,
  avatar:    String,
  addresses: Array,
  preferences: {
    newsletter: { type: Boolean, default: true },
    smsAlerts:  { type: Boolean, default: false },
  },
}, { timestamps: true }));

const Product = mongoose.model('Product', new mongoose.Schema({
  name:         { type: String, required: true },
  description:  { type: String, required: true },
  price:        { type: Number, required: true },
  comparePrice: Number,
  category:     { type: String, required: true },
  franchise:    { type: String, required: true },
  franchiseType:{ type: String, required: true },
  tags:         [String],
  images:       [String],
  sku:          { type: String, unique: true, required: true },
  stock:        { type: Number, required: true, default: 0 },
  sizes:        [String],
  colors:       [String],
  rating:       { average: Number, count: Number },
  isActive:     { type: Boolean, default: true },
}, { timestamps: true }));

// ── Seed data ─────────────────────────────────────────────────────────────────
async function seed() {
  const mongoURI = await getMongoURI();
  if (!mongoURI) {
    console.error('[seed] FATAL: MONGO_URI is not set and could not be loaded.');
    process.exit(1);
  }
  await mongoose.connect(mongoURI);
  console.log('[seed] Connected to MongoDB');

  // ── 1. Auth Users ────────────────────────────────────────────────────────
  await AuthUser.deleteMany({});
  console.log('[seed] Cleared authusers');

  const adminHash = await bcrypt.hash('Admin@12345', 12);
  const userHash  = await bcrypt.hash('User@12345',  12);

  const [adminAuth, demoAuth] = await AuthUser.create([
    {
      email:    'admin@fanvault.example.com',
      password: adminHash,
      role:     'admin',
      isActive: true,
    },
    {
      email:    'demo@fanvault.example.com',
      password: userHash,
      role:     'user',
      isActive: true,
    },
  ]);
  console.log(`[seed] Created 2 auth users (admin: ${adminAuth._id})`);

  // ── 2. User Profiles ─────────────────────────────────────────────────────
  await UserProfile.deleteMany({});
  console.log('[seed] Cleared userprofiles');

  await UserProfile.create([
    {
      authId:    adminAuth._id.toString(),
      email:     'admin@fanvault.example.com',
      firstName: 'Platform',
      lastName:  'Admin',
      addresses: [],
      preferences: { newsletter: false, smsAlerts: false },
    },
    {
      authId:    demoAuth._id.toString(),
      email:     'demo@fanvault.example.com',
      firstName: 'Demo',
      lastName:  'User',
      addresses: [
        {
          line1:      '42 MG Road',
          city:       'Bengaluru',
          state:      'Karnataka',
          postalCode: '560001',
          country:    'India',
          isDefault:  true,
        },
      ],
      preferences: { newsletter: true, smsAlerts: false },
    },
  ]);
  console.log('[seed] Created 2 user profiles');

  // ── 3. Products ───────────────────────────────────────────────────────────
  await Product.deleteMany({});
  console.log('[seed] Cleared products');

  await Product.create([
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
    {
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
    },
  ]);
  console.log('[seed] Created 5 products');

  console.log('\n[seed] ✅ Database seeding complete.');
  console.log('[seed] Admin login: admin@fanvault.example.com / Admin@12345');
  console.log('[seed] Demo login:  demo@fanvault.example.com / User@12345');
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('[seed] Fatal error:', err.message);
  mongoose.disconnect();
  process.exit(1);
});
