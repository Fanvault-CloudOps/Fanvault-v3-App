const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema({
  line1:      { type: String, required: true },
  line2:      { type: String },
  city:       { type: String, required: true },
  state:      { type: String, required: true },
  postalCode: { type: String, required: true },
  country:    { type: String, required: true, default: 'India' },
  isDefault:  { type: Boolean, default: false },
});

const userProfileSchema = new mongoose.Schema(
  {
    // Links back to the AuthUser._id
    authId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    firstName: {
      type: String,
      trim: true,
      maxlength: [50, 'First name cannot exceed 50 characters'],
    },
    lastName: {
      type: String,
      trim: true,
      maxlength: [50, 'Last name cannot exceed 50 characters'],
    },
    phone: {
      type: String,
      trim: true,
      match: [/^\+?[1-9]\d{6,14}$/, 'Please provide a valid phone number'],
    },
    avatar: {
      type: String,
      default: null,
    },
    addresses: [addressSchema],
    preferences: {
      newsletter: { type: Boolean, default: true },
      smsAlerts:  { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserProfile', userProfileSchema);
