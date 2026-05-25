const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  productId: { type: String, required: true },
  name:      { type: String, required: true },
  price:     { type: Number, required: true },
  quantity:  { type: Number, required: true, min: 1 },
  image:     { type: String },
  size:      { type: String },
  color:     { type: String },
});

const shippingAddressSchema = new mongoose.Schema({
  line1:      { type: String, required: true },
  line2:      { type: String },
  city:       { type: String, required: true },
  state:      { type: String, required: true },
  postalCode: { type: String, required: true },
  country:    { type: String, required: true, default: 'India' },
});

const orderSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    userEmail: {
      type: String,
      required: true,
    },
    orderNumber: {
      type: String,
      unique: true,
    },
    items:           [orderItemSchema],
    shippingAddress: { type: shippingAddressSchema, required: true },
    subtotal:        { type: Number, required: true },
    shippingCost:    { type: Number, default: 0 },
    tax:             { type: Number, default: 0 },
    total:           { type: Number, required: true },
    paymentMethod: {
      type: String,
      enum: ['cod', 'card', 'upi', 'netbanking'],
      default: 'cod',
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    status: {
      type: String,
      enum: ['placed', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
      default: 'placed',
    },
    notes:            { type: String },
    // notificationSent kept for data model compatibility — always true in v2 (no email service)
    notificationSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Auto-generate order number before first save
orderSchema.pre('save', async function (next) {
  if (!this.orderNumber) {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.orderNumber = `FAN-${timestamp}-${random}`;
  }
  next();
});

module.exports = mongoose.model('Order', orderSchema);
