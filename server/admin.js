const express = require('express');
const router = express.Router();
const db = require('./db');
const { authMiddleware, adminOnly, modOrAdmin } = require('./middleware');

router.get('/users', authMiddleware, modOrAdmin, async (req, res) => {
  try {
    const users = await db.query(
      'SELECT id, username, email, role, is_guest, status, avatar_color, avatar_initials, avatar_url, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(users);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/ban', authMiddleware, modOrAdmin, async (req, res) => {
  try {
    const { userId, reason, duration } = req.body;
    const target = await db.queryOne('SELECT * FROM users WHERE id=?', [userId]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') return res.status(403).json({ error: 'Cannot ban an admin' });
    if (target.role === 'moderator' && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Only admin can ban moderators' });
    const isPermanent = !duration;
    const expiresAt = duration ? new Date(Date.now() + duration * 3600000) : null;
    await db.query(
      'INSERT INTO bans (user_id, banned_by, reason, expires_at, is_permanent) VALUES (?,?,?,?,?)',
      [userId, req.user.id, reason || null, expiresAt, isPermanent]
    );
    res.json({ success: true, permanent: isPermanent });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/unban', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM bans WHERE user_id=?', [req.body.userId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/bans', authMiddleware, modOrAdmin, async (req, res) => {
  try {
    const bans = await db.query(`
      SELECT b.*, u.username as banned_username, a.username as banned_by_username
      FROM bans b
      LEFT JOIN users u ON b.user_id = u.id
      LEFT JOIN users a ON b.banned_by = a.id
      WHERE b.is_permanent=1 OR b.expires_at > NOW()
      ORDER BY b.created_at DESC
    `);
    res.json(bans);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/moderator', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.query('UPDATE users SET role=? WHERE id=?', ['moderator', req.body.userId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/remove-mod', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.query('UPDATE users SET role=? WHERE id=?', ['user', req.body.userId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.delete('/moderator/:userId', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.query('UPDATE users SET role=? WHERE id=?', ['user', req.params.userId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/clear-room/:roomId', authMiddleware, modOrAdmin, async (req, res) => {
  try {
    await db.query(
      'UPDATE messages SET is_deleted=1, deleted_by=?, deleted_at=NOW() WHERE room_id=?',
      [req.user.id, req.params.roomId]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
