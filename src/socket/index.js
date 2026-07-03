const { supabaseAdmin } = require('../services/supabase');
const { dequeue } = require('../services/matchmakingRedis');
const { authenticateSocket } = require('./authenticate');
const { socketLogger, attachUserContext } = require('./socketLogger');
const { setOnline, removeOnline, onlineCount, clearUserRoom } = require('./state');
const { clearRateLimitsFor } = require('./rateLimit');
const { socketConnectionRateLimiter } = require('./validation');
const { notifyFriendsPresence } = require('./presence');
const { startMatchLoop, registerMatchHandlers } = require('./match');
const { registerCallHandlers } = require('./calls');
const { registerChatHandlers } = require('./chat');
const { registerGlobalChatHandlers } = require('./globalChat');
const { registerSwipeHandlers } = require('./swipe');

// ── Main socket initialiser ───────────────────────────────────────────────
// Each feature area (matchmaking, calls, DM chat, global chat, swipes) lives
// in its own file under src/socket/ and exposes a register*Handlers(io,
// socket, ...) function. This file just wires them all up per connection.
//
// NOTE: online/rooms/userCurrentRoom now live in Redis (see state.js), so
// this server instance is stateless w.r.t. presence/call data — any
// instance behind the load balancer can serve any user.
function initSocket(io) {
  // Attach a correlation id + child logger to every socket first (so even
  // handshakes rejected by the checks below are traceable), then the cheap
  // IP-based flood check (rejects handshake spam before we ever touch a
  // JWT), then real authentication.
  io.use(socketLogger);
  io.use(socketConnectionRateLimiter);
  io.use(authenticateSocket);
  startMatchLoop(io);

  io.on('connection', async (socket) => {
    const { id: userId, username } = socket.user;
    attachUserContext(socket, socket.user);
    await setOnline(userId, socket.id);
    socket.join('global');

    socket.log.info('Socket connected');

    // Mark user online in DB (fire and forget)
    supabaseAdmin.from('users')
      .update({ status: 'online', last_seen: new Date().toISOString() })
      .eq('id', userId);

    notifyFriendsPresence(io, userId, 'online');
    io.emit('online:count', await onlineCount());

    registerMatchHandlers(io, socket, userId);
    registerCallHandlers(io, socket, userId, username);
    registerChatHandlers(io, socket, userId, username);
    registerGlobalChatHandlers(io, socket, userId);
    registerSwipeHandlers(io, socket, userId);

    // ── PRESENCE ──────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      clearRateLimitsFor(socket);
      await removeOnline(userId);
      await dequeue(userId);
      await clearUserRoom(io, userId);
      supabaseAdmin.from('users')
        .update({ status: 'offline', last_seen: new Date().toISOString() })
        .eq('id', userId);
      notifyFriendsPresence(io, userId, 'offline');
      io.emit('online:count', await onlineCount());
      socket.log.info('Socket disconnected');
    });
  });
}

module.exports = { initSocket };
