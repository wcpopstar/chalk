const router  = require('express').Router();
const { requireAuth } = require('../middleware/auth');

// Agora token generator
// npm package: agora-token
let RtcTokenBuilder, RtcRole;
try {
  const agora = require('agora-token');
  RtcTokenBuilder = agora.RtcTokenBuilder;
  RtcRole         = agora.RtcRole;
} catch (_) {
  console.warn('[calls] agora-token not installed — voice calls will be mocked');
}

// ── POST /api/calls/token ──────────────────────────────────────────────────
// Client calls this to get an Agora RTC token before joining a channel.
router.post('/token', requireAuth, async (req, res) => {
  const { channelName, uid } = req.body;

  if (!channelName) {
    return res.status(400).json({ error: 'channelName is required' });
  }

  const appId  = process.env.AGORA_APP_ID;
  const appCert = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCert || !RtcTokenBuilder) {
    // Dev fallback: return a dummy token so UI still works without Agora creds
    return res.json({
      token: 'DEV_MODE_NO_AGORA_CREDENTIALS',
      appId: appId || 'DEV',
      channelName,
      uid: uid || 0,
      expiresAt: Date.now() + 3600_000,
    });
  }

  const expirationTimeInSeconds = 3600; // 1 hour
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCert,
      channelName,
      uid || 0,
      RtcRole.PUBLISHER,
      privilegeExpiredTs,
    );

    res.json({
      token,
      appId,
      channelName,
      uid: uid || 0,
      expiresAt: privilegeExpiredTs * 1000,
    });
  } catch (err) {
    console.error('[calls/token]', err);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// ── POST /api/calls/start ──────────────────────────────────────────────────
// Logs a call start in the DB
router.post('/start', requireAuth, async (req, res) => {
  const { supabaseAdmin } = require('../services/supabase');
  const { v4: uuid } = require('uuid');
  const { roomId, participants, mode } = req.body;

  const { data, error } = await supabaseAdmin.from('calls').insert({
    id: roomId || uuid(),
    initiated_by: req.user.id,
    participants: participants || [req.user.id],
    mode: mode || 'solo',
    started_at: new Date().toISOString(),
    status: 'active',
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ call: data });
});

// ── PATCH /api/calls/:id/end ───────────────────────────────────────────────
router.patch('/:id/end', requireAuth, async (req, res) => {
  const { supabaseAdmin } = require('../services/supabase');
  const { duration_seconds } = req.body;

  const { error } = await supabaseAdmin.from('calls').update({
    ended_at: new Date().toISOString(),
    duration_seconds: duration_seconds || null,
    status: 'ended',
  }).eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
