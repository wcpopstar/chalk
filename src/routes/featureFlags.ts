import type { Request, Response } from 'express';
import { Router } from 'express';
const router = Router();
import { requireAuth } from '../middleware/auth';
import { requireAdminKey } from '../middleware/requireAdminKey';
import { validate } from '../middleware/validate';
import { userLimiter } from '../middleware/rateLimit';

// Bootstrap call fired once per session — loose, but not unbounded.
const bootstrapLimiter = userLimiter({ windowMs: 60 * 1000, max: 30, message: 'Too many requests, slow down.' });
import { setOverride, listFlags } from '../services/featureFlags';
import { flagKeyParam, setFlagBodySchema } from '../validation/featureFlagSchemas';
import { config } from '../config/env';

// Toggling flags is an ops action, not something that needs to survive a
// mash-click — a loose cap is just here to stop a leaked/rotated admin key
// from being used to hammer Redis in a loop.
const adminLimiter = userLimiter({ windowMs: 60 * 1000, max: 30, message: 'Too many admin requests, slow down.' });

/**
 * @openapi
 * /api/flags:
 *   get:
 *     tags: [Users]
 *     summary: Get resolved feature flags for the current user
 *     description: Client bootstrap call — nothing here is sensitive (it's just which UI features are currently on), so any authenticated user can read it. Resolved per-user so a flag with a rolloutPercent override comes back correctly bucketed for THIS user rather than as a global on/off.
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 flags:
 *                   type: object
 *                   additionalProperties: { type: boolean }
 *                   example: { 'discovery.enabled': true, 'games.tetris.enabled': true }
 */
router.get('/', requireAuth, bootstrapLimiter, async (req: Request, res: Response) => {
  const flags = await listFlags({ userId: req.user.id });
  const resolved: any = {};
  flags.forEach((f) => { resolved[f.key] = f.enabled; });
  // Not a stored flag — derived from server config so the client can hide the
  // "transcribe" button when no STT provider key is set.
  resolved['transcription.enabled'] = !!config.stt.enabled;
  return res.json({ flags: resolved });
});

// ── GET /api/flags/admin ─────────────────────────────────────────────────────
// Full detail (defaults, active overrides) — for an internal ops tool/CLI,
// not the client app.
router.get('/admin', requireAdminKey, adminLimiter, async (_req: Request, res: Response) => {
  const flags = await listFlags();
  return res.json({ flags });
});

// ── PATCH /api/flags/admin/:key ──────────────────────────────────────────────
// Body is either { enabled: true|false } or { rolloutPercent: 0-100 }.
router.patch(
  '/admin/:key',
  requireAdminKey,
  adminLimiter,
  validate({ params: flagKeyParam, body: setFlagBodySchema }),
  async (req: Request, res: Response) => {
    try {
      await setOverride(req.params.key!, req.body);
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
);

// ── DELETE /api/flags/admin/:key ─────────────────────────────────────────────
// Removes any live override, falling back to the env var / code default.
router.delete('/admin/:key', requireAdminKey, adminLimiter, validate({ params: flagKeyParam }), async (req: Request, res: Response) => {
  try {
    await setOverride(req.params.key!, null);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export = router;
