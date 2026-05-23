const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const COLORS = ['#5865F2','#57F287','#FEE75C','#EB459E','#ED4245','#FF7F50','#1ABC9C','#E67E22'];
const randColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
const initials = (name) => name.slice(0, 2).toUpperCase();
const signToken = (user) => jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });

    const exists = await db.queryOne('SELECT id FROM users WHERE email=? OR username=?', [email, username]);
    if (exists) return res.status(409).json({ error: 'Username or email already taken' });

    const hash = await bcrypt.hash(password, 10);
    const color = randColor();
    const result = await db.query(
      'INSERT INTO users (username, email, password_hash, avatar_color, avatar_initials) VALUES (?,?,?,?,?)',
      [username, email, hash, color, initials(username)]
    );
    const user = await db.queryOne('SELECT id, username, email, role, avatar_color, avatar_initials FROM users WHERE id=?', [result.insertId]);
    res.json({ token: signToken(user), user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.queryOne('SELECT * FROM users WHERE email=? AND is_guest=0', [email]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const banned = await db.queryOne(
      'SELECT * FROM bans WHERE user_id=? AND (is_permanent=1 OR expires_at > NOW())',
      [user.id]
    );
    if (banned) return res.status(403).json({ error: `You are banned. Reason: ${banned.reason || 'No reason given'}` });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const { password_hash, ...safeUser } = user;
    res.json({ token: signToken(safeUser), user: safeUser });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Guest login
router.post('/guest', async (req, res) => {
  try {
    const guestName = `Guest_${Math.floor(Math.random() * 9000) + 1000}`;
    const color = randColor();
    const result = await db.query(
      'INSERT INTO users (username, avatar_color, avatar_initials, is_guest) VALUES (?,?,?,1)',
      [guestName, color, 'GU']
    );
    const user = await db.queryOne('SELECT id, username, role, avatar_color, avatar_initials, is_guest FROM users WHERE id=?', [result.insertId]);
    res.json({ token: signToken(user), user });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Google OAuth
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/login?error=google' }),
  (req, res) => {
    const token = signToken(req.user);
    res.redirect(`/?token=${token}`);
  }
);

// Verify token
router.get('/me', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'No token' });
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await db.queryOne(
      'SELECT id, username, email, role, avatar_color, avatar_initials, is_guest, status FROM users WHERE id=?',
      [decoded.id]
    );
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ user });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
