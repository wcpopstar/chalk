// ── Express request augmentation ─────────────────────────────────────────
// Fields attached to `req` by this app's middleware, so route handlers can
// type themselves as plain express `Request` and still see them.
//
// `user` is declared non-optional on purpose: it is set by requireAuth()
// (middleware/auth.ts), and every handler that reads it is mounted behind
// requireAuth. Handlers NOT behind requireAuth must not touch req.user —
// that contract lives in the route wiring, not the type system, and
// declaring it optional would instead force a meaningless `!` on every
// legitimate access. optionalAuth() routes should treat it as possibly
// undefined explicitly (`req.user?.id`).
//
// `req.log` (pino child logger with the request's correlation id) is
// already typed by pino-http's own declaration merging — see
// middleware/requestLogger.ts.
import type { JwtPayload } from '../socket/types';

declare global {
  namespace Express {
    interface Request {
      /** Decoded access-token payload; set by requireAuth()/optionalAuth(). */
      user: JwtPayload;
      /** The raw bearer token that authenticated this request. */
      accessToken?: string;
    }
  }
}

export {};
