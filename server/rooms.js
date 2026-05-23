const express = require('express');
const router = express.Router();
const db = require('./db');
const { authMiddleware, adminOnly, modOrAdmin } = require('./middleware');

router.get('/', authMiddleware, async (req, res) => {
  try {
    const rooms = await db.query('SELECT * FROM rooms ORDER BY type, name');
    res.json(rooms);
  } catch (e) {
    console.error('[rooms]', e.message);
    res.status(500).json({ error: e.message });
  }
});


router.get('/debug', async (req, res) => {
  const results = {};
  const db = require('./db');
  try {
    results.rooms = await db.query('SELECT id, name FROM rooms LIMIT 3');
  } catch(e) { results.rooms_error = e.message; }
  try {
    results.messages = await db.query('SELECT id, room_id FROM messages LIMIT 3');
  } catch(e) { results.messages_error = e.message; }
  try {
    results.msg_columns = await db.query("SHOW COLUMNS FROM messages");
  } catch(e) { results.msg_columns_error = e.message; }
  try {
    results.pool_type = 'query (not execute)';
  } catch(e) {}
  res.json(results);
});

router.get('/members', authMiddleware, async (req, res) => {
  try {
    const users = await db.query(
      'SELECT id, username, avatar_color, avatar_initials, avatar_url, role, status, is_guest FROM users WHERE is_guest=0 OR id=? ORDER BY role DESC, username ASC',
      [req.user.id]
    );
    res.json(users);
  } catch (e) {
    console.error('[rooms]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/messages', authMiddleware, async (req, res) => {
  try {
    let messages;
    try {
      messages = await db.query(`
        SELECT m.*, u.username, u.avatar_color, u.avatar_initials, u.role
        FROM messages m
        LEFT JOIN users u ON m.sender_id = u.id
        WHERE m.room_id=? AND m.is_deleted=0
        ORDER BY m.created_at DESC LIMIT 50
      `, [req.params.id]);
    } catch (e1) {
      messages = await db.query(`
        SELECT m.*, u.username, u.avatar_color, u.avatar_initials, u.role
        FROM messages m
        LEFT JOIN users u ON m.sender_id = u.id
        WHERE m.room_id=?
        ORDER BY m.created_at DESC LIMIT 50
      `, [req.params.id]);
    }

    for (const msg of messages) {
      try {
        const reactions = await db.query(
          'SELECT emoji, COUNT(*) as count, MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) as mine FROM reactions WHERE message_id=? GROUP BY emoji',
          [req.user.id, msg.id]
        );
        msg.reactions = reactions.length ? reactions : null;
      } catch (_) {
        msg.reactions = null;
      }
    }
    res.json(messages.reverse());
  } catch (e) {
    console.error('[rooms]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/messages/:msgId', authMiddleware, modOrAdmin, async (req, res) => {
  try {
    await db.query(
      'UPDATE messages SET is_deleted=1, deleted_by=?, deleted_at=NOW() WHERE id=?',
      [req.user.id, req.params.msgId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[rooms]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/messages/:msgId/react', authMiddleware, async (req, res) => {
  try {
    const { emoji } = req.body;
    const existing = await db.queryOne(
      'SELECT id FROM reactions WHERE message_id=? AND user_id=? AND emoji=?',
      [req.params.msgId, req.user.id, emoji]
    );
    if (existing) {
      await db.query('DELETE FROM reactions WHERE id=?', [existing.id]);
      res.json({ action: 'removed' });
    } else {
      await db.query('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?,?,?)',
        [req.params.msgId, req.user.id, emoji]);
      res.json({ action: 'added' });
    }
  } catch (e) {
    console.error('[rooms]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, description, type } = req.body;
    const result = await db.query(
      'INSERT INTO rooms (name, description, type, created_by) VALUES (?,?,?,?)',
      [name, description || '', type || 'text', req.user.id]
    );
    const room = await db.queryOne('SELECT * FROM rooms WHERE id=?', [result.insertId]);
    res.json(room);
  } catch (e) {
    console.error('[rooms]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM rooms WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('[rooms]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;