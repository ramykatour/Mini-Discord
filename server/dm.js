const express = require('express');
const router = express.Router();
const db = require('./db');
const { authMiddleware } = require('./middleware');

// GET DM conversations list
router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    const convos = await db.query(`
      SELECT
        u.id, u.username, u.avatar_color, u.avatar_initials, u.status,
        (SELECT COUNT(*) FROM direct_messages
          WHERE receiver_id=? AND sender_id=u.id AND is_read=0) as unread,
        (SELECT content FROM direct_messages
          WHERE (sender_id=? AND receiver_id=u.id) OR (sender_id=u.id AND receiver_id=?)
          ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM direct_messages
          WHERE (sender_id=? AND receiver_id=u.id) OR (sender_id=u.id AND receiver_id=?)
          ORDER BY created_at DESC LIMIT 1) as last_time
      FROM users u
      WHERE u.id != ? AND u.id IN (
        SELECT CASE WHEN sender_id=? THEN receiver_id ELSE sender_id END
        FROM direct_messages WHERE sender_id=? OR receiver_id=?
      )
      ORDER BY last_time DESC
    `, [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]);
    res.json(convos);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET DM messages with a user (last 50)
router.get('/:userId', authMiddleware, async (req, res) => {
  try {
    const messages = await db.query(`
      SELECT dm.*, u.username, u.avatar_color, u.avatar_initials
      FROM direct_messages dm
      JOIN users u ON dm.sender_id = u.id
      WHERE (dm.sender_id=? AND dm.receiver_id=?)
         OR (dm.sender_id=? AND dm.receiver_id=?)
      ORDER BY dm.created_at DESC LIMIT 50
    `, [req.user.id, req.params.userId, req.params.userId, req.user.id]);

    // Mark as read
    await db.query(
      'UPDATE direct_messages SET is_read=1 WHERE sender_id=? AND receiver_id=?',
      [req.params.userId, req.user.id]
    );

    res.json(messages.reverse());
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
