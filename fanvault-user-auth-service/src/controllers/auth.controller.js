const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const User = require('../models/User');

// ── Token generation helper ──────────────────────────────────────────────────
const generateTokens = (userId, role) => {
  const accessToken = jwt.sign(
    { id: userId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  const refreshToken = jwt.sign(
    { id: userId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
  return { accessToken, refreshToken };
};

// ── POST /api/auth/register ──────────────────────────────────────────────────
exports.register = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser)
      return res.status(409).json({ error: 'Email already registered' });

    const user = await User.create({ email, password });
    const { accessToken, refreshToken } = generateTokens(user._id, user.role);

    res.status(201).json({
      message: 'Registration successful',
      accessToken,
      refreshToken,
      user: { id: user._id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('[auth] register error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── POST /api/auth/login ─────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+password');

    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ error: 'Invalid email or password' });

    if (!user.isActive)
      return res.status(403).json({ error: 'Account deactivated' });

    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    const { accessToken, refreshToken } = generateTokens(user._id, user.role);

    res.json({
      message: 'Login successful',
      accessToken,
      refreshToken,
      user: { id: user._id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── POST /api/auth/refresh ───────────────────────────────────────────────────
exports.refresh = (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res.status(401).json({ error: 'Refresh token required' });

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const accessToken = jwt.sign(
      { id: decoded.id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
    );
    res.json({ accessToken });
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
};

// ── GET /api/auth/verify ─────────────────────────────────────────────────────
// Used optionally by external clients to check token validity
exports.verify = (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer '))
      return res.status(401).json({ valid: false, error: 'No token provided' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ valid: true, user: { id: decoded.id, role: decoded.role } });
  } catch (err) {
    res.status(401).json({ valid: false, error: 'Invalid or expired token' });
  }
};

// ── POST /api/auth/logout ────────────────────────────────────────────────────
// Stateless — client is responsible for discarding stored tokens
exports.logout = (req, res) => {
  res.json({ message: 'Logged out successfully' });
};
