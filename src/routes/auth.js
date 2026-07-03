const router    = require('express').Router();
const bcrypt    = require('bcryptjs');
const crypto    = require('crypto');
const { v4: uuid } = require('uuid');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../services/supabase');
const { sendPasswordResetEmail } = require('../services/mailer');
const { registerSchema, loginSchema } = require('../validation/schemas');
const { generateUsername } = require('../utils/usernames');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } = require('../utils/jwt');
const tokenBlacklist = require('../services/tokenBlacklist');
const {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  InvalidRefreshTokenError,
  TokenReuseError,
} = require('../services/refreshTokens');

const USER_FIELDS =
  'id, username, email, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, presence, created_at';

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

// Refresh/rotation gets its own generous-but-bounded limit, keyed by IP —
// it's hit far more often than login but should still be capped against abuse.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many refresh attempts, try again later.' },
});

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function requestMeta(req) {
  return { userAgent: req.headers['user-agent'] || null, ip: req.ip };
}

// Issues a fresh access + refresh token pair for a user and shapes the
// standard auth response body.
async function issueSession(user, req) {
  const { token, jti } = signAccessToken({ id: user.id, username: user.username });
  const { raw: refreshToken } = await issueRefreshToken(user.id, requestMeta(req));
  return { token, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, jti };
}

// Blacklists whatever access token authenticated the current request, if any
// — used by /logout and /logout-all so the token that's still "live" for up
// to 15 more minutes can't keep being used after the user asked to sign out.
function blacklistCurrentAccessToken(req) {
  if (req.user?.jti && req.user?.exp) {
    tokenBlacklist.revoke(req.user.jti, req.user.exp * 1000);
  }
}

// ── POST /api/auth/register ────────────────────────────────────────────────
router.post('/register', authLimiter, async (req, res) => {
  try {
    const parsed = registerSchema.parse({ ...req.body, languages: req.body.languages || ['en'] });
    const { email, password, country, languages } = parsed;
    const username = (parsed.username || '').trim() || generateUsername();

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
      .select(USER_FIELDS)
      .single();

    if (error) {
      req.log.error({ err: error }, 'Failed to insert new user during registration');
      return res.status(500).json({ error: 'Could not create account' });
    }

    const { token, refreshToken, expiresIn } = await issueSession(user, req);
    res.status(201).json({ user, token, refreshToken, expiresIn });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Invalid request payload', details: error.errors.map(e => e.message) });
    }
    req.log.error({ err: error }, 'Registration failed');
    res.status(500).json({ error: 'Could not create account' });
  }
});

// ── POST /api/auth/login ───────────────────────────────────────────────────
router.post('/login', authLimiter, loginEmailLimiter, async (req, res) => {
  try {
    const parsed = loginSchema.parse(req.body);
    const { email, password } = parsed;

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

    await supabaseAdmin.from('users').update({ status: 'online', last_seen: new Date().toISOString() }).eq('id', user.id);

    const { password_hash, ...safeUser } = user;
    const { token, refreshToken, expiresIn } = await issueSession(user, req);
    res.json({ user: safeUser, token, refreshToken, expiresIn });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Invalid request payload', details: error.errors.map(e => e.message) });
    }
    req.log.error({ err: error }, 'Login failed');
    res.status(500).json({ error: 'Could not log in' });
  }
});

// ── POST /api/auth/refresh ──────────────────────────────────────────────────
// Exchanges a refresh token for a new access + refresh token pair. The
// refresh token is single-use (rotation): the one presented here is revoked
// and a new one is issued in its place, even if the caller doesn't end up
// using the response. Presenting an already-rotated token is treated as
// theft and revokes every session descended from it (see refreshTokens.js).
router.post('/refresh', refreshLimiter, async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  try {
    const { raw: newRefreshToken, userId } = await rotateRefreshToken(refreshToken, requestMeta(req));

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, username')
      .eq('id', userId)
      .maybeSingle();

    if (error || !user) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }

    const { token, expiresIn } = signAccessToken({ id: user.id, username: user.username });
    res.json({ token, refreshToken: newRefreshToken, expiresIn });
  } catch (err) {
    if (err instanceof TokenReuseError) {
      req.log.warn('Refresh token reuse detected — session family revoked');
      return res.status(401).json({ error: 'Session invalidated, please log in again', code: 'TOKEN_REUSE' });
    }
    if (err instanceof InvalidRefreshTokenError) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
    req.log.error({ err }, 'Token refresh failed');
    res.status(500).json({ error: 'Could not refresh session' });
  }
});

// ── POST /api/auth/logout ───────────────────────────────────────────────────
// Logs out the current device/session: revokes the refresh token it sent (if
// any) and blacklists whatever access token was still valid.
router.post('/logout', optionalAuth, async (req, res) => {
  const { refreshToken } = req.body || {};

  if (refreshToken && typeof refreshToken === 'string') {
    await revokeRefreshToken(refreshToken);
  }
  blacklistCurrentAccessToken(req);

  if (req.user) {
    await supabaseAdmin.from('users').update({ status: 'offline', last_seen: new Date().toISOString() }).eq('id', req.user.id);
  }
  res.json({ ok: true });
});

// ── POST /api/auth/logout-all ───────────────────────────────────────────────
// Revokes every refresh token for the account (all devices/sessions) — for
// "sign out everywhere" or when a user suspects their account is compromised.
router.post('/logout-all', requireAuth, async (req, res) => {
  await revokeAllForUser(req.user.id);
  blacklistCurrentAccessToken(req);
  await supabaseAdmin.from('users').update({ status: 'offline', last_seen: new Date().toISOString() }).eq('id', req.user.id);
  res.json({ ok: true });
});

// ── GET /api/auth/me ───────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, username, email, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, status, presence, bio, created_at')
    .eq('id', req.user.id)
    .single();
  res.json({ user });
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
    req.log.error({ err: error }, 'Failed to create password reset record');
    return res.status(500).json({ error: 'Could not start password reset' });
  }

  const baseUrl = process.env.CLIENT_URL || `${req.protocol}://${req.get('host')}`;
  const resetUrl = `${baseUrl}/?reset=${rawToken}`;

  try {
    await sendPasswordResetEmail(user.email, resetUrl);
  } catch (e) {
    req.log.error({ err: e }, 'Failed to send password reset email');
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
    req.log.error({ err: updateError }, 'Failed to update password during reset');
    return res.status(500).json({ error: 'Could not reset password' });
  }

  await supabaseAdmin
    .from('password_resets')
    .update({ used_at: new Date().toISOString() })
    .eq('id', resetRow.id);

  // A password reset means any credential-holder before this point should be
  // logged out — revoke every existing session for the account.
  await revokeAllForUser(resetRow.user_id);

  res.json({ ok: true });
});

module.exports = router;
