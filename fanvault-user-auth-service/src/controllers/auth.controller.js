const jwt       = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const UserRepository = require('../models/User');

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

    // Check if email already registered via GSI
    const existing = await UserRepository.findByEmail(email);
    if (existing)
      return res.status(409).json({ error: 'Email already registered' });

    const user = await UserRepository.create({ email, password });
    const { accessToken, refreshToken } = generateTokens(user.userId, user.role);

    res.status(201).json({
      message: 'Registration successful',
      accessToken,
      refreshToken,
      user: { id: user.userId, email: user.email, role: user.role },
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
    const user = await UserRepository.findByEmail(email);

    // Constant-time: always call comparePassword even if user not found
    const dummyHash = '$2a$12$dummyhashtopreventtimingattacks.AAAAAAAAAAAAAAAAAAAAAA';
    const passwordHash = user?.passwordHash || dummyHash;
    const isMatch = await UserRepository.comparePassword(password, passwordHash);

    if (!user || !isMatch)
      return res.status(401).json({ error: 'Invalid email or password' });

    if (!user.isActive)
      return res.status(403).json({ error: 'Account deactivated' });

    // Update lastLogin timestamp (non-blocking — don't await)
    UserRepository.updateLastLogin(user.userId).catch((e) =>
      console.warn('[auth] lastLogin update failed:', e.message)
    );

    const { accessToken, refreshToken } = generateTokens(user.userId, user.role);

    res.json({
      message: 'Login successful',
      accessToken,
      refreshToken,
      user: { id: user.userId, email: user.email, role: user.role },
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
exports.verify = (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer '))
      return res.status(401).json({ valid: false, error: 'No token provided' });

    const token   = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ valid: true, user: { id: decoded.id, role: decoded.role } });
  } catch (err) {
    res.status(401).json({ valid: false, error: 'Invalid or expired token' });
  }
};

// ── POST /api/auth/logout ────────────────────────────────────────────────────
// Stateless — client discards stored tokens
exports.logout = (req, res) => {
  res.json({ message: 'Logged out successfully' });
};
