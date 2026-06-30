const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { v4: uuid } = require('uuid');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../services/supabase');
const { sendPasswordResetEmail } = require('../services/mailer');

// Strict rate limit for auth endpoints, keyed by IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts, try again later.' },
});

// Additional limit on /login keyed by the email being attempted, so an
// attacker can't bypass the IP limit by rotating IPs against one account.
const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : req.ip),
  message: { error: 'Слишком много попыток входа для этого email. Попробуй позже или сбрось пароль.' },
});

// Limit on /forgot-password keyed by email, so it can't be used to spam someone's inbox.
const forgotPasswordEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body && req.body.email ? String(req.body.email).toLowerCase().trim() : req.ip),
  message: { error: 'Слишком много запросов на сброс пароля для этого email. Попробуй позже.' },
});

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
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
      onboarding_completed: false,
      created_at: new Date().toISOString(),
    })
    .select('id, username, email, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, presence, created_at')
    .single();

  if (error) {
    console.error('[register]', error);
    return res.status(500).json({ error: 'Could not create account' });
  }

  const token = signToken({ id: user.id, username: user.username });
  res.status(201).json({ user, token });
});

// ── POST /api/auth/login ───────────────────────────────────────────────────
router.post('/login', authLimiter, loginEmailLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, username, email, password_hash, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, status, presence')
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
      .select('id, username, email, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, status, presence, bio, created_at')
      .eq('id', payload.id)
      .single();
    res.json({ user });
  } catch (_) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ── POST /api/auth/forgot-password ─────────────────────────────────────────
router.post('/forgot-password', authLimiter, forgotPasswordEmailLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'email is required' });
  }

  // Always respond with the same generic message, whether or not the email
  // exists — this avoids leaking which emails are registered.
  const genericResponse = { ok: true, message: 'Если такой email зарегистрирован, на него отправлена ссылка для сброса пароля.' };

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, email')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (!user) {
    return res.json(genericResponse);
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

  const { error } = await supabaseAdmin.from('password_resets').insert({
    user_id: user.id,
    token_hash: hashToken(rawToken),
    expires_at: expiresAt,
  });

  if (error) {
    console.error('[forgot-password]', error);
    return res.status(500).json({ error: 'Could not start password reset' });
  }

  const baseUrl = process.env.CLIENT_URL || `${req.protocol}://${req.get('host')}`;
  const resetUrl = `${baseUrl}/?reset=${rawToken}`;

  try {
    await sendPasswordResetEmail(user.email, resetUrl);
  } catch (e) {
    console.error('[forgot-password] failed to send email', e);
    // Don't reveal the failure to the client — still respond generically.
  }

  res.json(genericResponse);
});

// ── POST /api/auth/reset-password ──────────────────────────────────────────
router.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'token and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const tokenHash = hashToken(token);

  const { data: resetRow, error: lookupError } = await supabaseAdmin
    .from('password_resets')
    .select('id, user_id, expires_at, used_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (lookupError || !resetRow || resetRow.used_at || new Date(resetRow.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Ссылка для сброса пароля недействительна или устарела' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const { error: updateError } = await supabaseAdmin
    .from('users')
    .update({ password_hash: passwordHash })
    .eq('id', resetRow.user_id);

  if (updateError) {
    console.error('[reset-password]', updateError);
    return res.status(500).json({ error: 'Could not reset password' });
  }

  await supabaseAdmin
    .from('password_resets')
    .update({ used_at: new Date().toISOString() })
    .eq('id', resetRow.id);

  res.json({ ok: true });
});

module.exports = router;
