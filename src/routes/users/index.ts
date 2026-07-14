import { Router } from 'express';
import profile from './profile';
import discovery from './discovery';
import moderation from './moderation';
import publicProfile from './publicProfile';
const router = Router();

// ── IMPORTANT: specific routes MUST be mounted before /:id ────────────────
// Otherwise Express matches "me", "me/stats", "discover" as :id — see
// publicProfile.js for details. Keep it mounted last.
//   profile.js       — PATCH /me, POST /me/onboarding, PUT /me/games, GET /me/stats
//   discovery.js      — GET /discover, GET /search
//   moderation.js      — GET /me/blocked, /:id/block, /:id/report
//   publicProfile.js   — GET /:id  (must stay last)
router.use(profile);
router.use(discovery);
router.use(moderation);
router.use(publicProfile);

export = router;
