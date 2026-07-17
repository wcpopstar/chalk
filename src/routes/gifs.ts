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
import express from 'express';
import { Readable } from 'stream';
import rateLimit from 'express-rate-limit';
const router = express.Router();
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { userLimiter, createRateLimitStore } from '../middleware/rateLimit';
import { gifSearchQuerySchema, gifProxyQuerySchema } from '../validation/gifSchemas';
import loggerBase from '../utils/logger';
const logger = loggerBase.child({ module: 'gifs' });
import { config } from '../config/env';

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

// ── GIF media proxy ─────────────────────────────────────────────────────────
// The picker/search above only returns *URLs* — the actual GIF bytes were
// loaded by the browser straight from media*.giphy.com. For users whose
// network can't reach Giphy's CDN (regional blocks, corporate filters), every
// GIF in chat rendered as a broken image even though search worked fine.
// This endpoint streams the image through our backend instead.
//
// Deliberately NOT behind requireAuth: it's fetched via <img src>, which
// can't attach the Authorization header this app's auth uses. Abuse is
// bounded instead by (a) a strict host allowlist — this can only ever fetch
// from Giphy's own media hosts, so it's not an open proxy / SSRF surface,
// (b) an IP rate limit, and (c) aggressive browser caching below so repeat
// views don't hit us at all.
const GIPHY_MEDIA_HOSTS = /^(media\d*\.giphy\.com|i\.giphy\.com)$/;
const PROXY_MAX_BYTES = 15 * 1024 * 1024;

const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  store: createRateLimitStore(),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов, подожди немного.' },
});

/**
 * @openapi
 * /api/gifs/media:
 *   get:
 *     tags: [Gifs]
 *     summary: Proxy a Giphy media URL (for clients that can't reach Giphy's CDN)
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: The image bytes }
 *       400: { description: URL is not an allowed Giphy media URL }
 *       502: { description: Upstream fetch failed }
 */
router.get(
  '/media',
  proxyLimiter,
  validate({ query: gifProxyQuerySchema }),
  async (req: Request, res: Response) => {
    const { url } = req.query as unknown as { url: string };

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    if (parsed.protocol !== 'https:' || !GIPHY_MEDIA_HOSTS.test(parsed.hostname)) {
      return res.status(400).json({ error: 'Only Giphy media URLs are allowed' });
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(parsed.toString(), {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      logger.warn({ err }, 'Giphy media fetch failed');
      return res.status(502).json({ error: 'Media temporarily unavailable' });
    }

    // Redirects are followed above — re-check the FINAL host so a (however
    // unlikely) redirect off giphy.com can't turn this into an open proxy.
    try {
      if (upstream.url && !GIPHY_MEDIA_HOSTS.test(new URL(upstream.url).hostname)) {
        return res.status(502).json({ error: 'Media temporarily unavailable' });
      }
    } catch { /* keep the original-URL verdict */ }

    const type = upstream.headers.get('content-type') || '';
    const length = Number(upstream.headers.get('content-length') || 0);
    if (!upstream.ok || !type.startsWith('image/') || length > PROXY_MAX_BYTES) {
      logger.warn({ status: upstream.status, type, length }, 'Giphy media response rejected');
      return res.status(502).json({ error: 'Media temporarily unavailable' });
    }

    res.setHeader('Content-Type', type);
    if (length) res.setHeader('Content-Length', String(length));
    // Giphy media URLs are content-addressed (the id is in the path), so the
    // bytes never change for a given URL — let browsers/CDN cache hard.
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (!upstream.body) return res.status(502).json({ error: 'Media temporarily unavailable' });
    const stream = Readable.fromWeb(upstream.body as any);
    stream.on('error', () => { res.destroy(); });
    return stream.pipe(res);
  },
);

export = router;
