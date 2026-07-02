const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { userCurrentRoom } = require('../socket/state');

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

/**
 * Agora numeric UIDs must be 32-bit unsigned integers. Our app uses
 * Supabase UUID strings as user ids, so we deterministically hash any
 * non-numeric uid into a stable positive integer. This MUST exactly match
 * the toNumericUid() logic in public/voice.js, otherwise the uid embedded
 * in the token won't match the uid the client joins with, and Agora will
 * reject the token with "invalid token, authorized failed".
 */
function toNumericUid(rawUid) {
  if (rawUid === null || rawUid === undefined || rawUid === '') {
    return 0;
  }

  const str = String(rawUid);

  if (/^\d+$/.test(str)) {
    const n = parseInt(str, 10) % 2147483647;
    return n || 1;
  }

  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return (hash % 2147483647) || 1;
}

// GET /api/agora/token?channel=voice-<roomId>
router.get('/token', requireAuth, (req, res) => {
  const channel = req.query.channel || 'chalk';

  // The caller may only request a token for the voice channel of the call
  // room they are actually in right now (tracked server-side, not by the
  // client-supplied channel string).
  const myRoomId = userCurrentRoom.get(req.user.id);
  if (channel !== `voice-${myRoomId}`) {
    return res.status(403).json({ error: 'Not a participant of this call' });
  }

  // Never trust a client-supplied uid — always identify the caller as
  // themselves, so tokens can't be requested on behalf of another user.
  const uid = toNumericUid(req.user.id);

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
