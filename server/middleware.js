const jwt = require('jsonwebtoken');
const db = require('./db');

const authMiddleware = async (req, res, next) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await db.queryOne(
      'SELECT id, username, role, avatar_color, avatar_initials, avatar_url, is_guest FROM users WHERE id=?',
      [decoded.id]
    );
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
};

const modOrAdmin = (req, res, next) => {
  if (!['admin', 'moderator'].includes(req.user?.role)) return res.status(403).json({ error: 'Moderator or admin required' });
  next();
};

module.exports = { authMiddleware, adminOnly, modOrAdmin };
