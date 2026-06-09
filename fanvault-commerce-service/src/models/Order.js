const {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} = require('@aws-sdk/lib-dynamodb');
const { getDocClient } = require('../config/db');
const { v4: uuidv4 } = require('uuid');

const TABLE = () => process.env.DYNAMODB_TABLE_ORDERS || 'fanvault-orders';

// ── Order number generator (replaces Mongoose pre-save hook) ─────────────────
function generateOrderNumber() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random    = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `FAN-${timestamp}-${random}`;
}

// ── OrderRepository ───────────────────────────────────────────────────────────
// Replaces the Mongoose Order model.
// GSIs: userId-createdAt-index, orderNumber-index, status-createdAt-index

const OrderRepository = {
  // ── Create a new order ──────────────────────────────────────────────────────
  async create({ userId, userEmail, items, shippingAddress, subtotal, shippingCost, tax, total, paymentMethod, notes }) {
    const now   = new Date().toISOString();
    const order = {
      orderId:          uuidv4(),
      orderNumber:      generateOrderNumber(),
      userId,
      userEmail,
      items:            items || [],
      shippingAddress,
      subtotal:         Number(subtotal),
      shippingCost:     Number(shippingCost ?? 0),
      tax:              Number(tax ?? 0),
      total:            Number(total),
      paymentMethod:    paymentMethod || 'cod',
      paymentStatus:    'pending',
      status:           'placed',
      notes:            notes || null,
      notificationSent: true, // No email service in v2 — always true
      createdAt:        now,
      updatedAt:        now,
    };

    await getDocClient().send(
      new PutCommand({
        TableName:           TABLE(),
        Item:                order,
        ConditionExpression: 'attribute_not_exists(orderId)',
      })
    );

    return { ...order, _id: order.orderId };
  },

  // ── Get a single order by orderId ───────────────────────────────────────────
  async findById(orderId) {
    const result = await getDocClient().send(
      new GetCommand({
        TableName: TABLE(),
        Key:       { orderId },
      })
    );
    return result.Item ? { ...result.Item, _id: result.Item.orderId } : null;
  },

  // ── Get paginated orders for a user (userId-createdAt-index GSI) ────────────
  // Returns most recent orders first (ScanIndexForward = false).
  async findByUserId(userId, { limit = 10, lastKey } = {}) {
    const result = await getDocClient().send(
      new QueryCommand({
        TableName:                 TABLE(),
        IndexName:                 'userId-createdAt-index',
        KeyConditionExpression:    'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ScanIndexForward:          false, // Most recent first
        Limit:                     Number(limit),
        ExclusiveStartKey:         lastKey,
      })
    );

    const mappedOrders = (result.Items || []).map(o => ({ ...o, _id: o.orderId }));

    return {
      orders:  mappedOrders,
      lastKey: result.LastEvaluatedKey || null,
      hasMore: !!result.LastEvaluatedKey,
    };
  },

  // ── Admin: get all orders, optionally filtered by status ───────────────────
  async findAll({ status, limit = 20, lastKey } = {}) {
    let result;

    if (status) {
      // Use status-createdAt-index GSI for status-filtered queries
      result = await getDocClient().send(
        new QueryCommand({
          TableName:                 TABLE(),
          IndexName:                 'status-createdAt-index',
          KeyConditionExpression:    '#status = :status',
          ExpressionAttributeNames:  { '#status': 'status' }, // 'status' is a reserved word
          ExpressionAttributeValues: { ':status': status },
          ScanIndexForward:          false,
          Limit:                     Number(limit),
          ExclusiveStartKey:         lastKey,
        })
      );
    } else {
      // No status filter — full Scan
      result = await getDocClient().send(
        new ScanCommand({
          TableName:         TABLE(),
          Limit:             Number(limit),
          ExclusiveStartKey: lastKey,
        })
      );
    }

    const mappedOrders = (result.Items || []).map(o => ({ ...o, _id: o.orderId }));

    return {
      orders:  mappedOrders,
      lastKey: result.LastEvaluatedKey || null,
      hasMore: !!result.LastEvaluatedKey,
    };
  },

  // ── Update order status and/or paymentStatus ───────────────────────────────
  async updateStatus(orderId, { status, paymentStatus }) {
    const sets   = ['updatedAt = :now'];
    const values = { ':now': new Date().toISOString() };
    const names  = {};

    if (status) {
      sets.push('#status = :status');
      names['#status']   = 'status';
      values[':status']  = status;
    }
    if (paymentStatus) {
      sets.push('paymentStatus = :ps');
      values[':ps'] = paymentStatus;
    }

    const result = await getDocClient().send(
      new UpdateCommand({
        TableName:                 TABLE(),
        Key:                       { orderId },
        UpdateExpression:          `SET ${sets.join(', ')}`,
        ExpressionAttributeNames:  Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: values,
        ConditionExpression:       'attribute_exists(orderId)',
        ReturnValues:              'ALL_NEW',
      })
    );

    return result.Attributes ? { ...result.Attributes, _id: result.Attributes.orderId } : null;
  },

  // ── Cancel an order (with guard: cannot cancel shipped/delivered) ───────────
  async cancel(orderId) {
    try {
        const result = await getDocClient().send(
          new UpdateCommand({
            TableName:        TABLE(),
            Key:              { orderId },
            UpdateExpression: 'SET #status = :cancelled, updatedAt = :now',
            // Conditional: only cancel if status is NOT shipped or delivered
            ConditionExpression:       'attribute_exists(orderId) AND #status <> :shipped AND #status <> :delivered',
            ExpressionAttributeNames:  { '#status': 'status' },
            ExpressionAttributeValues: {
              ':cancelled': 'cancelled',
              ':shipped':   'shipped',
              ':delivered': 'delivered',
              ':now':       new Date().toISOString(),
            },
            ReturnValues: 'ALL_NEW',
          })
        );
        return result.Attributes ? { ...result.Attributes, _id: result.Attributes.orderId } : null;
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        const conflict = new Error('Order cannot be cancelled at this stage');
        conflict.code  = 'CANCEL_FORBIDDEN';
        throw conflict;
      }
      throw err;
    }
  },
};

module.exports = OrderRepository;
