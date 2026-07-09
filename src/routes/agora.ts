const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { userLimiter } = require('../middleware/rateLimit');
const { tokenQuerySchema } = require('../validation/agoraSchemas');
const { getUserCurrentRoom } = require('../socket/state');
const logger = require('../utils/logger').child({ module: 'agora' });
const { config } = require('../config/env');

// A client legitimately re-requests a token on reconnect/token-expiry, but
// there's no reason for dozens of requests per minute from one account.
const tokenLimiter = userLimiter({ windowMs: 60 * 1000, max: 30, message: 'Слишком много запросов токена, подожди немного.' });

let RtcTokenBuilder: any;
let RtcRole: any;

try {
  const agora = require('agora-token');
  RtcTokenBuilder = agora.RtcTokenBuilder;
  RtcRole = agora.RtcRole;
} catch (err: any) {
  logger.warn({ err }, 'agora-token not available, voice chat will run in dev fallback mode');
}

// Missing AGORA_APP_ID/AGORA_APP_CERTIFICATE is already flagged at startup
// by config/env.ts's validateEnv() (in production) — this is just where
// the values are actually consumed.
const APP_ID          = config.agora.appId;
const APP_CERTIFICATE = config.agora.appCertificate;

/**
 * Agora numeric UIDs must be 32-bit unsigned integers. Our app uses
 * Supabase UUID strings as user ids, so we deterministically hash any
 * non-numeric uid into a stable positive integer. This MUST exactly match
 * the toNumericUid() logic in public/voice.js, otherwise the uid embedded
 * in the token won't match the uid the client joins with, and Agora will
 * reject the token with "invalid token, authorized failed".
 */
function toNumericUid(rawUid: any) {
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

/**
 * @openapi
 * /api/agora/token:
 *   get:
 *     tags: [Agora]
 *     summary: Get an Agora RTC token for the caller's current call
 *     description: "The caller may only request a token for the voice channel of the call room they are actually in right now (verified server-side against Redis-backed room state, not trusted from the client). If AGORA_APP_CERTIFICATE isn't configured, returns a dev-fallback response instead (token is null, mode is set to dev)."
 *     parameters:
 *       - in: query
 *         name: channel
 *         required: true
 *         schema: { type: string }
 *         description: 'Must equal `voice-{roomId}` for the room the caller is currently in.'
 *     responses:
 *       200:
 *         description: Token issued (or dev fallback)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token: { type: string, nullable: true }
 *                 appId: { type: string }
 *                 channel: { type: string }
 *                 uid: { type: integer, description: "Deterministic 32-bit uid derived from the user's UUID" }
 *                 mode: { type: string, enum: [dev], description: 'Present only when running without AGORA_APP_CERTIFICATE' }
 *       403:
 *         description: Not a participant of this call
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       503:
 *         description: Agora not configured (AGORA_APP_ID missing)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/token', requireAuth, tokenLimiter, validate({ query: tokenQuerySchema }), async (req: any, res: any) => {
  const channel = req.query.channel;

  // The caller may only request a token for the voice channel of the call
  // room they are actually in right now (tracked server-side, not by the
  // client-supplied channel string).
  const myRoomId = await getUserCurrentRoom(req.user.id);
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

export = router;
