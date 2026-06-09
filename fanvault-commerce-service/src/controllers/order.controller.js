const { validationResult } = require('express-validator');
const OrderRepository = require('../models/Order');
const ProductRepository = require('../models/Product');
const { publishEvent } = require('../utils/eventPublisher');

// ── Internal: log order event locally (email service omitted) ────────────────
const logOrderEvent = (eventType, order) => {
  console.log(
    JSON.stringify({
      event:       eventType,
      orderNumber: order.orderNumber,
      userEmail:   order.userEmail,
      total:       order.total,
      status:      order.status,
      timestamp:   new Date().toISOString(),
    })
  );
};

// ── POST /api/orders ──────────────────────────────────────────────────────────
exports.createOrder = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { items, shippingAddress, paymentMethod, notes, userEmail } = req.body;

    // Pricing logic: 18% GST, free shipping above ₹1999
    const subtotal     = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shippingCost = subtotal >= 1999 ? 0 : 99;
    const tax          = Math.round(subtotal * 0.18);
    const total        = subtotal + shippingCost + tax;

    const order = await OrderRepository.create({
      userId:          req.user.id,
      userEmail:       userEmail || req.user.email,
      items,
      shippingAddress,
      subtotal,
      shippingCost,
      tax,
      total,
      paymentMethod:   paymentMethod || 'cod',
      notes,
    });

    logOrderEvent('ORDER_PLACED', order);

    // Publish OrderPlaced domain event
    publishEvent('OrderPlaced', {
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      userId: order.userId,
      userEmail: order.userEmail,
      total: order.total,
      items: order.items,
      timestamp: order.createdAt
    });

    // Update product stock and check for low stock
    for (const item of items) {
      try {
        const product = await ProductRepository.findById(item.productId);
        if (product) {
          const newStock = Math.max(0, Number(product.stock || 0) - Number(item.quantity));
          await ProductRepository.update(item.productId, { stock: newStock });
          console.log(`[order] Decremented stock for product ${item.productId}. Old: ${product.stock}, New: ${newStock}`);
          
          if (newStock <= 5) {
            publishEvent('InventoryLow', {
              productId: item.productId,
              name: product.name,
              sku: product.sku,
              stock: newStock,
              timestamp: new Date().toISOString()
            });
          }
        }
      } catch (updateErr) {
        console.error(`[order] Failed to update stock for item ${item.productId}:`, updateErr.message);
      }
    }

    res.status(201).json({ message: 'Order placed successfully', order });
  } catch (err) {
    console.error('[order] createOrder error:', err.message);
    
    // Publish structured order failure alert to SNS
    const topicArn = process.env.SNS_TOPIC_ORDER_FAILURE;
    if (topicArn) {
      try {
        const { publishAlert } = require('../utils/snsPublisher');
        publishAlert(topicArn, {
          service: 'fanvault-commerce-service',
          eventType: 'OrderProcessingFailure',
          resource: req.user ? `User:${req.user.id}` : 'Guest',
          severity: 'ERROR',
          correlationId: req.headers['x-correlation-id'] || 'system',
          details: {
            errorMessage: err.message,
            stackTrace: err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : '',
            requestBody: req.body,
            userId: req.user ? req.user.id : null,
            userEmail: req.user ? req.user.email : null
          }
        });
      } catch (snsErr) {
        console.error('[order] Failed to send order failure alert to SNS:', snsErr.message);
      }
    }

    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/orders/my — paginated user order history ────────────────────────
exports.getMyOrders = async (req, res) => {
  try {
    const { limit = 10, lastKey: rawKey } = req.query;

    let lastKey;
    try {
      lastKey = rawKey ? JSON.parse(Buffer.from(rawKey, 'base64').toString()) : undefined;
    } catch {
      lastKey = undefined;
    }

    const { orders, lastKey: nextKey, hasMore } = await OrderRepository.findByUserId(
      req.user.id,
      { limit: Number(limit), lastKey }
    );

    res.json({
      orders,
      pagination: {
        count:   orders.length,
        hasMore,
        nextKey: nextKey ? Buffer.from(JSON.stringify(nextKey)).toString('base64') : null,
      },
    });
  } catch (err) {
    console.error('[order] getMyOrders error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/orders/:id — user or admin ───────────────────────────────────────
exports.getOrder = async (req, res) => {
  try {
    const order = await OrderRepository.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Users can only see their own orders; admins can see all
    if (order.userId !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });

    res.json({ order });
  } catch (err) {
    console.error('[order] getOrder error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/orders — admin: all orders with optional status filter ────────────
exports.getAllOrders = async (req, res) => {
  try {
    const { status, limit = 20, lastKey: rawKey } = req.query;

    let lastKey;
    try {
      lastKey = rawKey ? JSON.parse(Buffer.from(rawKey, 'base64').toString()) : undefined;
    } catch {
      lastKey = undefined;
    }

    const { orders, lastKey: nextKey, hasMore } = await OrderRepository.findAll({
      status,
      limit: Number(limit),
      lastKey,
    });

    res.json({
      orders,
      pagination: {
        count:   orders.length,
        hasMore,
        nextKey: nextKey ? Buffer.from(JSON.stringify(nextKey)).toString('base64') : null,
      },
    });
  } catch (err) {
    console.error('[order] getAllOrders error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── PATCH /api/orders/:id/status — admin ─────────────────────────────────────
exports.updateOrderStatus = async (req, res) => {
  try {
    const { status, paymentStatus } = req.body;
    const order = await OrderRepository.updateStatus(req.params.id, { status, paymentStatus });

    if (status === 'confirmed') logOrderEvent('ORDER_CONFIRMED', order);
    res.json({ message: 'Order updated', order });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException')
      return res.status(404).json({ error: 'Order not found' });
    console.error('[order] updateOrderStatus error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── POST /api/orders/:id/cancel — user cancel (before shipped) ───────────────
exports.cancelOrder = async (req, res) => {
  try {
    // Verify ownership first
    const order = await OrderRepository.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.userId !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });

    // Cancel with atomic DynamoDB conditional expression
    const cancelled = await OrderRepository.cancel(req.params.id);
    logOrderEvent('ORDER_CANCELLED', cancelled);
    res.json({ message: 'Order cancelled', order: cancelled });
  } catch (err) {
    if (err.code === 'CANCEL_FORBIDDEN')
      return res.status(400).json({ error: 'Order cannot be cancelled at this stage' });
    console.error('[order] cancelOrder error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};
