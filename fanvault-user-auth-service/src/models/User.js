const { PutCommand, GetCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { getDocClient } = require('../config/db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const TABLE = () => process.env.DYNAMODB_TABLE_USERS || 'fanvault-users';

// ── UserRepository ────────────────────────────────────────────────────────────
// Replaces the Mongoose AuthUser model. All DynamoDB operations are here.
// Password hashing is handled inside this repository (previously in mongoose pre-save hook).

const UserRepository = {
  // ── Create a new user (registration) ───────────────────────────────────────
  async create({ email, password, role = 'user' }) {
    const userId      = uuidv4();
    const passwordHash = await bcrypt.hash(password, 12);
    const now         = new Date().toISOString();

    const item = {
      userId,
      email: email.toLowerCase().trim(),
      passwordHash,
      role,
      isActive:  true,
      lastLogin: null,
      createdAt: now,
      updatedAt: now,
    };

    await getDocClient().send(
      new PutCommand({
        TableName:           TABLE(),
        Item:                item,
        // Prevent overwriting an existing user with the same userId (safety guard)
        ConditionExpression: 'attribute_not_exists(userId)',
      })
    );

    return item;
  },

  // ── Find user by email (login) — uses email-index GSI ──────────────────────
  async findByEmail(email) {
    const result = await getDocClient().send(
      new QueryCommand({
        TableName:                 TABLE(),
        IndexName:                 'email-index',
        KeyConditionExpression:    'email = :email',
        ExpressionAttributeValues: { ':email': email.toLowerCase().trim() },
        Limit:                     1,
      })
    );
    return result.Items?.[0] || null;
  },

  // ── Find user by primary key (userId) ──────────────────────────────────────
  async findById(userId) {
    const result = await getDocClient().send(
      new GetCommand({
        TableName: TABLE(),
        Key:       { userId },
      })
    );
    return result.Item || null;
  },

  // ── Update lastLogin timestamp ──────────────────────────────────────────────
  async updateLastLogin(userId) {
    await getDocClient().send(
      new UpdateCommand({
        TableName:                 TABLE(),
        Key:                       { userId },
        UpdateExpression:          'SET lastLogin = :now, updatedAt = :now',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      })
    );
  },

  // ── Compare plain password against stored hash ──────────────────────────────
  async comparePassword(candidatePassword, passwordHash) {
    return bcrypt.compare(candidatePassword, passwordHash);
  },
};

module.exports = UserRepository;
