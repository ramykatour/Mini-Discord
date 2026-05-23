const jwt = require('jsonwebtoken');
const db = require('./db');

const onlineUsers = new Map();
const userSockets = new Map();
const voiceRooms  = new Map();

module.exports = function setupSocket(io) {

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) return next(new Error('No token'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await db.queryOne(
        'SELECT id, username, role, avatar_color, avatar_initials, is_guest FROM users WHERE id=?',
        [decoded.id]
      );
      if (!user) return next(new Error('User not found'));
      const banned = await db.queryOne(
        'SELECT reason FROM bans WHERE user_id=? AND (is_permanent=1 OR expires_at > NOW())',
        [user.id]
      );
      if (banned) return next(new Error(`Banned: ${banned.reason || 'No reason'}`));
      socket.user = user;
      next();
    } catch (e) { next(new Error('Auth failed')); }
  });

  io.on('connection', async (socket) => {
    const user = socket.user;
    onlineUsers.set(socket.id, user);
    if (!userSockets.has(user.id)) userSockets.set(user.id, new Set());
    userSockets.get(user.id).add(socket.id);
    await db.query('UPDATE users SET status=? WHERE id=?', ['online', user.id]);
    io.emit('user:status', { userId: user.id, status: 'online' });
    socket.emit('users:online', [...new Set([...onlineUsers.values()].map(u => u.id))]);

    socket.on('room:join', (roomId) => { socket.join(`room:${roomId}`); });
    socket.on('room:leave', (roomId) => { socket.leave(`room:${roomId}`); });

    socket.on('message:send', async ({ roomId, content, type, gifUrl }) => {
      try {
        const result = await db.query(
          'INSERT INTO messages (room_id, sender_id, content, type, gif_url) VALUES (?,?,?,?,?)',
          [roomId, user.id, content || '', type || 'text', gifUrl || null]
        );
        const msg = await db.queryOne(
          `SELECT m.*, u.username, u.avatar_color, u.avatar_initials, u.avatar_url, u.role
           FROM messages m LEFT JOIN users u ON m.sender_id=u.id WHERE m.id=?`,
          [result.insertId]
        );
        io.to(`room:${roomId}`).emit('message:new', msg);
      } catch (e) { socket.emit('error', { message: 'Failed to send message' }); }
    });

    socket.on('message:delete', async ({ messageId, roomId }) => {
      if (!['admin','moderator'].includes(user.role)) return;
      await db.query('UPDATE messages SET is_deleted=1, deleted_by=?, deleted_at=NOW() WHERE id=?', [user.id, messageId]);
      io.to(`room:${roomId}`).emit('message:deleted', { messageId, deletedBy: user.username });
    });

    socket.on('room:clear', async ({ roomId }) => {
      if (!['admin','moderator'].includes(user.role)) return;
      await db.query('UPDATE messages SET is_deleted=1, deleted_by=?, deleted_at=NOW() WHERE room_id=?', [user.id, roomId]);
      io.to(`room:${roomId}`).emit('room:cleared', { roomId, by: user.username });
    });

    socket.on('reaction:toggle', async ({ messageId, emoji, roomId }) => {
      const ex = await db.queryOne('SELECT id FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', [messageId, user.id, emoji]);
      if (ex) { await db.query('DELETE FROM reactions WHERE id=?', [ex.id]); }
      else { await db.query('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?,?,?)', [messageId, user.id, emoji]); }
      const reactions = await db.query(
        'SELECT emoji, COUNT(*) as count, MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) as mine FROM reactions WHERE message_id=? GROUP BY emoji',
        [user.id, messageId]
      );
      io.to(`room:${roomId}`).emit('reaction:update', { messageId, reactions });
    });

    socket.on('dm:send', async ({ toUserId, content, type, gifUrl }) => {
      try {
        const result = await db.query(
          'INSERT INTO direct_messages (sender_id, receiver_id, content, type, gif_url) VALUES (?,?,?,?,?)',
          [user.id, toUserId, content || '', type || 'text', gifUrl || null]
        );
        const msg = await db.queryOne(
          `SELECT dm.*, u.username as sender_username, u.avatar_color, u.avatar_initials, u.avatar_url
           FROM direct_messages dm LEFT JOIN users u ON dm.sender_id=u.id WHERE dm.id=?`,
          [result.insertId]
        );
        socket.emit('dm:new', msg);
        const rs = userSockets.get(parseInt(toUserId));
        if (rs) rs.forEach(sid => io.to(sid).emit('dm:new', msg));
      } catch (e) { socket.emit('error', { message: 'DM failed' }); }
    });

    socket.on('dm:typing', ({ toUserId }) => {
      const rs = userSockets.get(parseInt(toUserId));
      if (rs) rs.forEach(sid => io.to(sid).emit('dm:typing', { fromUserId: user.id, fromUsername: user.username }));
    });

    socket.on('room:typing', ({ roomId }) => {
      socket.to(`room:${roomId}`).emit('room:typing', { userId: user.id, username: user.username });
    });

    socket.on('voice:join', ({ roomId }) => {
      if (!voiceRooms.has(roomId)) voiceRooms.set(roomId, new Map());
      const room = voiceRooms.get(roomId);
      socket.emit('voice:peers', [...room.entries()].map(([sid, u]) => ({ peerId: sid, userId: u.id, username: u.username })));
      room.set(socket.id, user);
      socket.join(`voice:${roomId}`);
      room.forEach((pu, pid) => {
        if (pid !== socket.id) io.to(pid).emit('voice:user-joined', { peerId: socket.id, userId: user.id, username: user.username });
      });
      io.to(`room:${roomId}`).emit('voice:members', { roomId, members: [...room.values()].map(u => ({ userId: u.id, username: u.username })) });
    });

    socket.on('voice:leave',  ({ roomId }) => leaveVoice(socket, roomId));
    socket.on('voice:offer',  ({ toPeerId, offer })      => io.to(toPeerId).emit('voice:offer',  { fromPeerId: socket.id, offer }));
    socket.on('voice:answer', ({ toPeerId, answer })     => io.to(toPeerId).emit('voice:answer', { fromPeerId: socket.id, answer }));
    socket.on('voice:ice',    ({ toPeerId, candidate })  => io.to(toPeerId).emit('voice:ice',    { fromPeerId: socket.id, candidate }));
    socket.on('voice:mute',   ({ roomId, muted })        => io.to(`voice:${roomId}`).emit('voice:mute-update', { userId: user.id, muted }));

    socket.on('admin:ban', async ({ userId, reason, duration }) => {
      if (!['admin','moderator'].includes(user.role)) return;
      const target = await db.queryOne('SELECT * FROM users WHERE id=?', [userId]);
      if (!target || target.role === 'admin') return;
      if (target.role === 'moderator' && user.role !== 'admin') return;
      const isPermanent = !duration;
      const expiresAt = duration ? new Date(Date.now() + duration * 3600000) : null;
      await db.query('INSERT INTO bans (user_id, banned_by, reason, expires_at, is_permanent) VALUES (?,?,?,?,?)',
        [userId, user.id, reason || null, expiresAt, isPermanent]);
      const bs = userSockets.get(parseInt(userId));
      if (bs) bs.forEach(sid => { io.to(sid).emit('banned', { reason: reason || 'No reason' }); io.sockets.sockets.get(sid)?.disconnect(true); });
      io.emit('system:message', { text: `🔨 ${target.username} was banned by ${user.username}. Reason: ${reason || 'No reason'}`, type: 'ban' });
    });

    socket.on('admin:set-mod', async ({ userId }) => {
      if (user.role !== 'admin') return;
      await db.query('UPDATE users SET role=? WHERE id=?', ['moderator', userId]);
      const target = await db.queryOne('SELECT username FROM users WHERE id=?', [userId]);
      io.emit('system:message', { text: `⭐ ${target.username} was promoted to Moderator by ${user.username}`, type: 'mod' });
      const ts = userSockets.get(parseInt(userId));
      if (ts) ts.forEach(sid => io.to(sid).emit('role:update', { role: 'moderator' }));
    });

    socket.on('status:set', async ({ status }) => {
      if (!['online','idle','dnd'].includes(status)) return;
      await db.query('UPDATE users SET status=? WHERE id=?', [status, user.id]);
      io.emit('user:status', { userId: user.id, status });
    });

    socket.on('disconnect', async () => {
      onlineUsers.delete(socket.id);
      const sockets = userSockets.get(user.id);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          userSockets.delete(user.id);
          await db.query('UPDATE users SET status=? WHERE id=?', ['offline', user.id]);
          io.emit('user:status', { userId: user.id, status: 'offline' });
        }
      }
      voiceRooms.forEach((room, roomId) => { if (room.has(socket.id)) leaveVoice(socket, roomId); });
    });

    function leaveVoice(socket, roomId) {
      const room = voiceRooms.get(roomId);
      if (!room) return;
      room.delete(socket.id);
      socket.leave(`voice:${roomId}`);
      io.to(`voice:${roomId}`).emit('voice:user-left', { peerId: socket.id, userId: user.id });
      io.to(`room:${roomId}`).emit('voice:members', { roomId, members: [...room.values()].map(u => ({ userId: u.id, username: u.username })) });
      if (room.size === 0) voiceRooms.delete(roomId);
    }
  });
};