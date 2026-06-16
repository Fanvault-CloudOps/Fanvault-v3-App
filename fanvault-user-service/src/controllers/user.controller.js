const { validationResult } = require('express-validator');
const UserProfileRepository = require('../models/UserProfile');

// ── GET /api/users/me ────────────────────────────────────────────────────────
exports.getProfile = async (req, res) => {
  try {
    const profile = await UserProfileRepository.findByUserId(req.user.id);
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

    // Check if profile already exists
    const existing = await UserProfileRepository.findByUserId(req.user.id);
    if (existing)
      return res.status(409).json({ error: 'Profile already exists' });

    const profile = await UserProfileRepository.create({
      userId:    req.user.id,
      email,
      firstName,
      lastName,
    });

    res.status(201).json({ message: 'Profile created', profile });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return res.status(409).json({ error: 'Profile already exists' });
    }
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

    const updated = await UserProfileRepository.update(req.user.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Profile not found' });

    res.json({ message: 'Profile updated', profile: updated });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ error: 'Profile not found' });
    }
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

    const updated = await UserProfileRepository.addAddress(req.user.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Profile not found' });

    res.status(201).json({ message: 'Address added', addresses: updated.addresses });
  } catch (err) {
    console.error('[user] addAddress error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── DELETE /api/users/me/addresses/:addressId ────────────────────────────────
exports.removeAddress = async (req, res) => {
  try {
    const updated = await UserProfileRepository.removeAddress(
      req.user.id,
      req.params.addressId
    );
    if (!updated) return res.status(404).json({ error: 'Profile not found' });

    res.json({ message: 'Address removed', addresses: updated.addresses });
  } catch (err) {
    console.error('[user] removeAddress error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};
