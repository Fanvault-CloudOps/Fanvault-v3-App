const {
  PutCommand,
  GetCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { getDocClient } = require('../config/db');

const TABLE = () => process.env.DYNAMODB_TABLE_PROFILES || 'fanvault-profiles';

// ── UserProfileRepository ─────────────────────────────────────────────────────
// Replaces the Mongoose UserProfile model.
// PK is userId — always obtained from the verified JWT payload (req.user.id).

const UserProfileRepository = {
  // ── Get profile by userId ───────────────────────────────────────────────────
  async findByUserId(userId) {
    const result = await getDocClient().send(
      new GetCommand({
        TableName: TABLE(),
        Key:       { userId },
      })
    );
    return result.Item || null;
  },

  // ── Create a new profile after registration ─────────────────────────────────
  async create({ userId, email, firstName, lastName }) {
    const now = new Date().toISOString();

    const item = {
      userId,
      email: email.toLowerCase().trim(),
      firstName:   firstName || null,
      lastName:    lastName  || null,
      phone:       null,
      avatar:      null,
      addresses:   [],
      preferences: { newsletter: true, smsAlerts: false },
      createdAt:   now,
      updatedAt:   now,
    };

    await getDocClient().send(
      new PutCommand({
        TableName:           TABLE(),
        Item:                item,
        ConditionExpression: 'attribute_not_exists(userId)', // Prevent duplicate profile
      })
    );

    return item;
  },

  // ── Update allowed profile fields ───────────────────────────────────────────
  async update(userId, fields) {
    // Build a dynamic UpdateExpression from the provided fields
    const allowed = ['firstName', 'lastName', 'phone', 'preferences'];
    const sets    = ['updatedAt = :updatedAt'];
    const values  = { ':updatedAt': new Date().toISOString() };

    allowed.forEach((field) => {
      if (fields[field] !== undefined) {
        sets.push(`${field} = :${field}`);
        values[`:${field}`] = fields[field];
      }
    });

    const result = await getDocClient().send(
      new UpdateCommand({
        TableName:                 TABLE(),
        Key:                       { userId },
        UpdateExpression:          `SET ${sets.join(', ')}`,
        ExpressionAttributeValues: values,
        ConditionExpression:       'attribute_exists(userId)', // Fail if profile missing
        ReturnValues:              'ALL_NEW',
      })
    );

    return result.Attributes;
  },

  // ── Append a new address to the addresses list ──────────────────────────────
  async addAddress(userId, address) {
    // If isDefault=true, clear all other defaults first via a read-modify-write
    const profile = await this.findByUserId(userId);
    if (!profile) return null;

    const addresses = profile.addresses || [];
    const newAddr   = {
      addressId: require('uuid').v4(),
      ...address,
    };

    // Clear other defaults if this one is default
    const updated = addresses.map((a) =>
      address.isDefault ? { ...a, isDefault: false } : a
    );
    updated.push(newAddr);

    const result = await getDocClient().send(
      new UpdateCommand({
        TableName:                 TABLE(),
        Key:                       { userId },
        UpdateExpression:          'SET addresses = :addresses, updatedAt = :now',
        ExpressionAttributeValues: {
          ':addresses': updated,
          ':now':       new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    return result.Attributes;
  },

  // ── Remove an address by addressId ─────────────────────────────────────────
  async removeAddress(userId, addressId) {
    const profile = await this.findByUserId(userId);
    if (!profile) return null;

    const filtered = (profile.addresses || []).filter(
      (a) => a.addressId !== addressId
    );

    const result = await getDocClient().send(
      new UpdateCommand({
        TableName:                 TABLE(),
        Key:                       { userId },
        UpdateExpression:          'SET addresses = :addresses, updatedAt = :now',
        ExpressionAttributeValues: {
          ':addresses': filtered,
          ':now':       new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    return result.Attributes;
  },
};

module.exports = UserProfileRepository;
