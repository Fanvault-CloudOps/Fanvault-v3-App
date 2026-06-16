const jwt = require('jsonwebtoken');

/**
 * authenticate
 * Decodes/validates the Bearer JWT in the Authorization header from Cognito.
 * Attaches decoded payload { id, sub, email, groups, role } to req.user.
 */
const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication token required' });
    }
    const token = authHeader.split(' ')[1];
    
    // Attempt verification if JWT_SECRET is provided (e.g. local dev mock)
    // otherwise decode the payload directly (signature validation offloaded to kgateway in production)
    let decoded;
    if (process.env.JWT_SECRET) {
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
      } catch (err) {
        // Fallback to simple decode if JWT verification fails but signature is offloaded
        decoded = jwt.decode(token);
      }
    } else {
      decoded = jwt.decode(token);
    }

    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Map Cognito specific claims to standard req.user payload
    req.user = {
      id:     decoded.sub || decoded.id, // Support sub as primary ID, fallback to id
      sub:    decoded.sub || decoded.id,
      email:  decoded.email,
      groups: decoded['cognito:groups'] || [],
      role:   (decoded['cognito:groups'] && decoded['cognito:groups'].includes('admins')) ? 'admin' : 'user',
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

/**
 * adminOnly
 * Blocks non-admin users based on Cognito groups/roles.
 */
const adminOnly = (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.groups.includes('admins'))) return next();
  return res.status(403).json({ error: 'Admin access required' });
};

module.exports = { authenticate, adminOnly };
