"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const router = require('express').Router();
// ── IMPORTANT: specific routes MUST be mounted before /:id ────────────────
// Otherwise Express matches "me", "me/stats", "discover" as :id — see
// publicProfile.js for details. Keep it mounted last.
//   profile.js       — PATCH /me, POST /me/onboarding, PUT /me/games, GET /me/stats
//   discovery.js      — GET /discover, GET /search
//   moderation.js      — GET /me/blocked, /:id/block, /:id/report
//   publicProfile.js   — GET /:id  (must stay last)
router.use(require('./profile'));
router.use(require('./discovery'));
router.use(require('./moderation'));
router.use(require('./publicProfile'));
module.exports = router;
//# sourceMappingURL=index.js.map