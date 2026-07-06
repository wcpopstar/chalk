"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Socket.IO logging middleware.
 *
 * HTTP requests get a correlation id from pino-http (see
 * middleware/requestLogger.js); this is the socket.io equivalent — every
 * socket connection gets its own short-lived "connection id" plus a child
 * logger (`socket.log`) that automatically tags every line with it (and,
 * once authenticated, with the userId/username too).
 *
 * Register BEFORE authenticateSocket so that even rejected/unauthenticated
 * handshakes are traceable:
 *
 *   io.use(socketLogger);
 *   io.use(socketConnectionRateLimiter);
 *   io.use(authenticateSocket);
 *
 * Usage inside any handler module:
 *   function registerChatHandlers(io, socket, userId, username) {
 *     socket.on('message:send', async (payload) => {
 *       socket.log.info({ event: 'message:send' }, 'Message received');
 *       ...
 *       socket.log.error({ err }, 'Failed to save message');
 *     });
 *   }
 */
const { randomUUID } = require('crypto');
const logger = require('../utils/logger');
function socketLogger(socket, next) {
    const connectionId = randomUUID();
    socket.connectionId = connectionId;
    socket.log = logger.child({ connectionId, socketId: socket.id });
    next();
}
/**
 * Call once a socket has been authenticated to enrich its logger with
 * user context, so every subsequent log line from this socket is
 * attributable to a user without repeating userId in every call site.
 */
function attachUserContext(socket, { id: userId, username } = {}) {
    socket.log = socket.log.child({ userId, username });
}
module.exports = { socketLogger, attachUserContext };
//# sourceMappingURL=socketLogger.js.map