import type { TypedSocket, JwtPayload } from './types';
import { verifyAccessToken } from '../utils/jwt';
import tokenBlacklist from '../services/tokenBlacklist';

// ── Authenticate socket via handshake token ─────────────────────────────────
// Validates the same short-lived access JWT used by the HTTP API (signature,
// issuer, audience, expiry) and rejects it if it's been explicitly revoked
// (logout / logout-all / refresh-token-reuse). On success it also arms a
// timer that force-disconnects the socket the moment the access token
// naturally expires, instead of letting a long-lived socket connection
// outlive the credential that authenticated it — sockets don't get to be an
// exception to token expiry just because they're long-lived.
function authenticateSocket(socket: TypedSocket, next: (err?: Error) => void) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;

  if (!token || typeof token !== 'string') {
    return next(new Error('Authentication required'));
  }

  let payload: JwtPayload;
  try {
    payload = verifyAccessToken(token);
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      return next(new Error('TOKEN_EXPIRED'));
    }
    return next(new Error('Invalid token'));
  }

  if (tokenBlacklist.isRevoked(payload.jti)) {
    return next(new Error('TOKEN_REVOKED'));
  }

  applyAuth(socket, payload);

  // Lets an already-connected client swap in a freshly-refreshed access
  // token (after hitting POST /api/auth/refresh) without a full socket
  // reconnect. The client should call this proactively before the token
  // in use expires.
  socket.on('auth:refresh', (newToken, ack) => {
    const respond = (result: { ok: boolean; error?: string; expiresAt?: number }) => {
      if (typeof ack === 'function') ack(result);
    };

    if (!newToken || typeof newToken !== 'string') {
      return respond({ ok: false, error: 'Missing token' });
    }

    let newPayload: JwtPayload;
    try {
      newPayload = verifyAccessToken(newToken);
    } catch (err: any) {
      return respond({ ok: false, error: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN' });
    }

    if (tokenBlacklist.isRevoked(newPayload.jti)) {
      return respond({ ok: false, error: 'TOKEN_REVOKED' });
    }

    // Refreshed token must belong to the same account — a socket can't
    // silently hijack another user's session via this channel.
    if (newPayload.id !== socket.data.user?.id) {
      return respond({ ok: false, error: 'USER_MISMATCH' });
    }

    applyAuth(socket, newPayload);
    respond({ ok: true, expiresAt: socket.data.tokenExpiresAt });
  });

  next();
}

// Attaches the decoded token to the socket and (re)schedules the
// expiry-driven disconnect.
function applyAuth(socket: TypedSocket, payload: JwtPayload) {
  clearTimeout(socket.data.tokenExpiryTimer);

  socket.data.user = payload;
  socket.data.tokenExpiresAt = payload.exp * 1000;

  const msUntilExpiry = socket.data.tokenExpiresAt - Date.now();
  socket.data.tokenExpiryTimer = setTimeout(() => {
    socket.emit('auth:expired');
    socket.disconnect(true);
  }, Math.max(msUntilExpiry, 0));
  socket.data.tokenExpiryTimer.unref?.();

  socket.once('disconnect', () => clearTimeout(socket.data.tokenExpiryTimer));
}

export { authenticateSocket };
