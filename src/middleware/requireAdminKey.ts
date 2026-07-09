import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import loggerBase from '../utils/logger';
import { config } from '../config/env';
const logger = loggerBase.child({ module: 'admin-auth' });

/**
 * Gates the feature-flag admin endpoints behind a shared secret header
 * rather than building out a full admin-role system for a single ops tool.
 * If ADMIN_API_KEY isn't set, the admin endpoints are disabled entirely
 * (fail closed, not open) — safer default for something that toggles
 * production behavior.
 */
function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const configuredKey = config.admin.apiKey;
  if (!configuredKey) {
    return res.status(503).json({ error: 'Admin endpoints are disabled (ADMIN_API_KEY not configured)' });
  }
  const providedKey = req.get('x-admin-key') || '';

  // Constant-time comparison — a plain !== leaks how many leading characters
  // matched via response timing. Buffers must be equal length for
  // timingSafeEqual, so pad/hash both sides to a fixed length first.
  const a = crypto.createHash('sha256').update(providedKey).digest();
  const b = crypto.createHash('sha256').update(configuredKey).digest();
  const matches = providedKey.length > 0 && crypto.timingSafeEqual(a, b);

  if (!matches) {
    logger.warn({ ip: req.ip }, 'Rejected admin request with missing/invalid x-admin-key');
    return res.status(401).json({ error: 'Invalid or missing admin key' });
  }
  return next();
}

export { requireAdminKey };
