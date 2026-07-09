/**
 * GIF search — proxies Giphy's search API instead of letting the browser
 * call it directly.
 *
 * Previously, public/js/global-chat.js called api.giphy.com straight from
 * the client with a Giphy key hardcoded in that file. That's a bad pattern
 * even for a low-stakes, rate-limited "beta" key: it's still a credential
 * tied to someone's Giphy account (100 req/hour cap per account, see
 * Giphy's docs), and hardcoding it in a file shipped to every visitor's
 * browser means anyone can lift it and burn that shared quota, or it shows
 * up in any scan of the public repo/site looking for "committed secrets"
 * even though the actual risk here is quota exhaustion, not data exposure.
 * Routing it through our own backend keeps the key server-side (like every
 * other third-party credential in this app — Supabase, Agora, SMTP) and
 * lets us rate-limit per-account on top of Giphy's own per-key limit.
 */
import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { userLimiter } = require('../middleware/rateLimit');
const { gifSearchQuerySchema } = require('../validation/gifSchemas');
const logger = require('../utils/logger').child({ module: 'gifs' });
const { config } = require('../config/env');

// Giphy's own beta key is capped at 100 calls/hour total; this just keeps
// any single chatty account from being the one that burns through it.
const searchLimiter = userLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Слишком много запросов GIF, подожди немного.',
});

/**
 * @openapi
 * /api/gifs/search:
 *   get:
 *     tags: [Gifs]
 *     summary: Search GIFs (proxies Giphy — the API key stays server-side)
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, default: 12 }
 *     responses:
 *       200:
 *         description: Matching GIFs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       thumb: { type: string }
 *                       full: { type: string }
 *       502:
 *         description: Giphy request failed or returned a non-OK response
 *       503:
 *         description: GIF search not configured (GIPHY_API_KEY missing)
 */
router.get(
  '/search',
  requireAuth,
  searchLimiter,
  validate({ query: gifSearchQuerySchema }),
  async (req: Request, res: Response) => {
    if (!config.giphy.apiKey) {
      return res.status(503).json({ error: 'GIF search is not configured' });
    }

    // Parsed by gifSearchQuerySchema in validate() — q is a bounded
    // string, limit a coerced number with a default.
    const { q, limit } = req.query as unknown as { q: string; limit: number };
    const url =
      `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(config.giphy.apiKey)}` +
      `&q=${encodeURIComponent(q)}&limit=${limit}&rating=pg-13`;

    let giphyRes;
    try {
      giphyRes = await fetch(url);
    } catch (err) {
      logger.warn({ err }, 'Giphy request failed');
      return res.status(502).json({ error: 'GIF search is temporarily unavailable' });
    }

    if (!giphyRes.ok) {
      logger.warn({ status: giphyRes.status }, 'Giphy returned a non-OK response');
      return res.status(502).json({ error: 'GIF search is temporarily unavailable' });
    }

    const data: any = await giphyRes.json();
    // Reduce Giphy's (much larger) response to just what the picker needs,
    // rather than forwarding its full shape straight through.
    const results = (data.data || [])
      .map((g: any) => {
        const thumb =
          (g.images && g.images.fixed_width_small && g.images.fixed_width_small.url) ||
          (g.images && g.images.preview_gif && g.images.preview_gif.url) ||
          '';
        const full =
          (g.images && g.images.downsized && g.images.downsized.url) ||
          (g.images && g.images.fixed_width && g.images.fixed_width.url) ||
          thumb;
        return { id: g.id, thumb, full };
      })
      .filter((r: { id: string; thumb: string; full: string }) => r.thumb);

    return res.json({ results });
  },
);

export = router;
