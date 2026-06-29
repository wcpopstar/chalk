const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');

let RtcTokenBuilder;
let RtcRole;

try {
  const agora = require('agora-token');
  RtcTokenBuilder = agora.RtcTokenBuilder;
  RtcRole = agora.RtcRole;
} catch (_) {
  console.warn('[agora] agora-token not available, voice chat will run in dev fallback mode');
}

// NOTE: Never hard-code credentials — always use environment variables.
// A hard-coded App ID was removed; set AGORA_APP_ID in your .env file.
const APP_ID          = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// GET /api/agora/token?channel=test&uid=0
router.get('/token', requireAuth, (req, res) => {
  const channel = req.query.channel || 'chalk';
  const uid     = parseInt(req.query.uid) || 0;

  if (!channel) {
    return res.status(400).json({ error: 'channel is required' });
  }

  if (!APP_ID) {
    return res.status(503).json({ error: 'Agora App ID not configured' });
  }

  // Dev fallback: no certificate configured
  if (!APP_CERTIFICATE || !RtcTokenBuilder || !RtcRole) {
    return res.json({ token: null, appId: APP_ID, channel, uid, mode: 'dev' });
  }

  const role = RtcRole.PUBLISHER;
  const expirationTimeInSeconds = 3600;
  const privilegeExpiredTs = Math.floor(Date.now() / 1000) + expirationTimeInSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channel,
    uid,
    role,
    privilegeExpiredTs,
  );

  res.json({ token, appId: APP_ID, channel, uid });
});

module.exports = router;
