const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../services/supabase');

// Strict rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts, try again later.' },
});

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// ── POST /api/auth/register ────────────────────────────────────────────────
router.post('/register', authLimiter, async (req, res) => {
  const { username, email, password, country, languages = ['en'] } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  // Check uniqueness
  const { data: existing } = await supabaseAdmin
    .from('users')
    .select('id')
    .or(`email.eq.${email},username.eq.${username}`)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: 'Email or username already taken' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const id = uuid();

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .insert({
      id,
      username,
      email: email.toLowerCase(),
      password_hash: passwordHash,
      country: country || null,
      languages,
      avatar_emoji: '🎮',
      created_at: new Date().toISOString(),
    })
    .select('id, username, email, country, languages, avatar_emoji, created_at')
    .single();

  if (error) {
    console.error('[register]', error);
    return res.status(500).json({ error: 'Could not create account' });
  }

  const token = signToken({ id: user.id, username: user.username });
  res.status(201).json({ user, token });
});

// ── POST /api/auth/login ───────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, password_hash, country, languages, avatar_emoji, status')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Mark online
  await supabaseAdmin.from('users').update({ status: 'online', last_seen: new Date().toISOString() }).eq('id', user.id);

  const { password_hash, ...safeUser } = user;
  const token = signToken({ id: user.id, username: user.username });
  res.json({ user: safeUser, token });
});

// ── POST /api/auth/logout ──────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const { id } = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      await supabaseAdmin.from('users').update({ status: 'offline', last_seen: new Date().toISOString() }).eq('id', id);
    } catch (_) { /* ignore */ }
  }
  res.json({ ok: true });
});

// ── GET /api/auth/me ───────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, username, email, country, languages, avatar_emoji, status, bio, created_at')
      .eq('id', payload.id)
      .single();
    res.json({ user });
  } catch (_) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
