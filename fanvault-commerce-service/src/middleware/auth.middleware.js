const jwt = require('jsonwebtoken');

/**
 * authenticate
 * Validates the Bearer JWT in the Authorization header.
 * Attaches decoded payload { id, role } to req.user.
 */
const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer '))
      return res.status(401).json({ error: 'Authentication token required' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

/**
 * adminOnly
 * Must follow authenticate in the middleware chain.
 */
const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
};

module.exports = { authenticate, adminOnly };
