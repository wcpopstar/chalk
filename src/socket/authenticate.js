const jwt = require('jsonwebtoken');

// ── Authenticate socket via handshake token ───────────────────────────────
function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (_) {
    next(new Error('Invalid token'));
  }
}

module.exports = { authenticateSocket };
