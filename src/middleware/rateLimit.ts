import rateLimit from 'express-rate-limit';

/**
 * Rate limiter keyed by authenticated user id when available, falling back
 * to IP for anonymous requests. This is what we want for buttons a logged-in
 * person could mash (add friend, block, report, create group, ...): it
 * throttles per-account instead of per-IP, so it can't be dodged by people
 * sharing a NAT/office IP, and it can't be used to lock other users out.
 *
 * requireAuth() must run BEFORE this middleware on the route so req.user is set.
 */
function userLimiter({ windowMs, max, message }: any) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: any) => (req.user && req.user.id) ? `u:${req.user.id}` : req.ip,
    message: { error: message || 'Слишком много запросов, попробуй немного позже.' },
  });
}

export { userLimiter };
