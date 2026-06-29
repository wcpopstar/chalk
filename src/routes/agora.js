const express = require("express");
const router = express.Router();

let RtcTokenBuilder;
let RtcRole;

try {
  const agora = require("agora-token");
  RtcTokenBuilder = agora.RtcTokenBuilder;
  RtcRole = agora.RtcRole;
} catch (_) {
  console.warn("[agora] agora-token not available, voice chat will run in dev fallback mode");
}

const DEFAULT_APP_ID = process.env.AGORA_APP_ID || "78a6c18e54f34fe5a13aa04b4a2d89f3";
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// GET /api/agora/token?channel=test&uid=0
router.get("/token", (req, res) => {
  const channel = req.query.channel || "chalk";
  const uid = req.query.uid || 0;

  if (!channel) {
    return res.status(400).json({ error: "channel is required" });
  }

  if (!APP_CERTIFICATE || !RtcTokenBuilder || !RtcRole) {
    return res.json({
      token: null,
      appId: DEFAULT_APP_ID,
      channel,
      uid,
      mode: "dev"
    });
  }

  const role = RtcRole.PUBLISHER;
  const expirationTimeInSeconds = 3600;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(
    DEFAULT_APP_ID,
    APP_CERTIFICATE,
    channel,
    uid,
    role,
    privilegeExpiredTs
  );

  res.json({ token, appId: DEFAULT_APP_ID, channel, uid });
});

module.exports = router;