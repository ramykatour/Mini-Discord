const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const db = require('./db');
require('dotenv').config();

const COLORS = ['#5865F2','#57F287','#FEE75C','#EB459E','#ED4245','#FF7F50','#1ABC9C'];
const randColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails?.[0]?.value;
    let user = await db.queryOne('SELECT * FROM users WHERE google_id=?', [profile.id]);

    if (!user && email) {
      user = await db.queryOne('SELECT * FROM users WHERE email=?', [email]);
    }

    const photo = profile.photos?.[0]?.value || null;
    if (user) {
      await db.query('UPDATE users SET google_id=?, avatar_url=? WHERE id=?', [profile.id, photo, user.id]);
    } else {
      const base = profile.displayName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24) || 'user';
      const username = base + '_' + (Math.floor(Math.random() * 9000) + 1000);
      const initials = profile.displayName.slice(0, 2).toUpperCase();
      const color = randColor();
      const result = await db.query(
        'INSERT INTO users (username, email, google_id, avatar_color, avatar_initials, avatar_url) VALUES (?,?,?,?,?,?)',
        [username, email, profile.id, color, initials, photo]
      );
      user = await db.queryOne('SELECT * FROM users WHERE id=?', [result.insertId]);
    }

    const { password_hash, ...safeUser } = user;
    return done(null, safeUser);
  } catch (e) {
    return done(e, null);
  }
}));

module.exports = passport;
