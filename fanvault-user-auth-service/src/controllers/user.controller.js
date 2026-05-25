const { validationResult } = require('express-validator');
const UserProfile = require('../models/UserProfile');

// ── GET /api/users/me ────────────────────────────────────────────────────────
exports.getProfile = async (req, res) => {
  try {
    const profile = await UserProfile.findOne({ authId: req.user.id });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({ profile });
  } catch (err) {
    console.error('[user] getProfile error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── POST /api/users/me — create profile after registration ───────────────────
exports.createProfile = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { email, firstName, lastName } = req.body;

    const existing = await UserProfile.findOne({ authId: req.user.id });
    if (existing)
      return res.status(409).json({ error: 'Profile already exists' });

    const profile = await UserProfile.create({
      authId: req.user.id,
      email,
      firstName,
      lastName,
    });
    res.status(201).json({ message: 'Profile created', profile });
  } catch (err) {
    console.error('[user] createProfile error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── PATCH /api/users/me ──────────────────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const allowedFields = ['firstName', 'lastName', 'phone', 'preferences'];
    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    const profile = await UserProfile.findOneAndUpdate(
      { authId: req.user.id },
      updates,
      { new: true, runValidators: true }
    );
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({ message: 'Profile updated', profile });
  } catch (err) {
    console.error('[user] updateProfile error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── POST /api/users/me/addresses ─────────────────────────────────────────────
exports.addAddress = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const profile = await UserProfile.findOne({ authId: req.user.id });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    // Clear other defaults if this is set as default
    if (req.body.isDefault) {
      profile.addresses.forEach((addr) => (addr.isDefault = false));
    }
    profile.addresses.push(req.body);
    await profile.save();
    res.status(201).json({ message: 'Address added', addresses: profile.addresses });
  } catch (err) {
    console.error('[user] addAddress error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── DELETE /api/users/me/addresses/:addressId ────────────────────────────────
exports.removeAddress = async (req, res) => {
  try {
    const profile = await UserProfile.findOne({ authId: req.user.id });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    profile.addresses = profile.addresses.filter(
      (a) => a._id.toString() !== req.params.addressId
    );
    await profile.save();
    res.json({ message: 'Address removed', addresses: profile.addresses });
  } catch (err) {
    console.error('[user] removeAddress error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};
