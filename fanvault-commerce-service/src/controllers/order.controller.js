const { validationResult } = require('express-validator');
const Order = require('../models/Order');

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

// ── POST /api/orders ─────────────────────────────────────────────────────────
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

    const order = await Order.create({
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
      notificationSent: true, // No external email service — mark as handled
    });

    // Log the order event for audit trail (replaces email notification)
    logOrderEvent('ORDER_PLACED', order);

    res.status(201).json({ message: 'Order placed successfully', order });
  } catch (err) {
    console.error('[order] createOrder error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/orders/my — paginated user order history ────────────────────────
exports.getMyOrders = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const [orders, total] = await Promise.all([
      Order.find({ userId: req.user.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Order.countDocuments({ userId: req.user.id }),
    ]);
    res.json({
      orders,
      pagination: { total, page: Number(page), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (err) {
    console.error('[order] getMyOrders error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/orders/:id — user or admin ──────────────────────────────────────
exports.getOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.userId !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });
    res.json({ order });
  } catch (err) {
    console.error('[order] getOrder error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/orders — admin: all orders with pagination and status filter ─────
exports.getAllOrders = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const query = status ? { status } : {};
    const skip  = (Number(page) - 1) * Number(limit);
    const [orders, total] = await Promise.all([
      Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Order.countDocuments(query),
    ]);
    res.json({
      orders,
      pagination: { total, page: Number(page), pages: Math.ceil(total / Number(limit)) },
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
    const update = {};
    if (status)        update.status        = status;
    if (paymentStatus) update.paymentStatus = paymentStatus;

    const order = await Order.findByIdAndUpdate(req.params.id, update, {
      new:          true,
      runValidators: true,
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (status === 'confirmed') logOrderEvent('ORDER_CONFIRMED', order);

    res.json({ message: 'Order updated', order });
  } catch (err) {
    console.error('[order] updateOrderStatus error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── POST /api/orders/:id/cancel — user cancel (before shipped) ───────────────
exports.cancelOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.userId !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Forbidden' });

    if (['shipped', 'delivered'].includes(order.status))
      return res.status(400).json({ error: 'Order cannot be cancelled at this stage' });

    order.status = 'cancelled';
    await order.save();
    logOrderEvent('ORDER_CANCELLED', order);
    res.json({ message: 'Order cancelled', order });
  } catch (err) {
    console.error('[order] cancelOrder error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};
