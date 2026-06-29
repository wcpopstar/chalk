const express = require("express");
const router = express.Router();

const { RtcTokenBuilder, RtcRole } = require("agora-token");

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// GET /api/agora/token?channel=test&uid=0
router.get("/token", (req, res) => {
  const channel = req.query.channel;
  const uid = req.query.uid || 0;

  if (!channel) {
    return res.status(400).json({ error: "channel is required" });
  }

  const role = RtcRole.PUBLISHER;
  const expireTime = 3600;

  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channel,
    uid,
    role,
    expireTime
  );

  res.json({ token });
});

module.exports = router;