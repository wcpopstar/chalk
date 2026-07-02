const { supabaseAdmin } = require('../services/supabase');
const { dequeue } = require('./matchmaking');
const { authenticateSocket } = require('./authenticate');
const { online, clearUserRoom } = require('./state');
const { clearRateLimitsFor } = require('./rateLimit');
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
function initSocket(io) {
  io.use(authenticateSocket);
  startMatchLoop(io);

  io.on('connection', (socket) => {
    const { id: userId, username } = socket.user;
    online.set(userId, socket.id);
    socket.join('global');

    console.log(`[socket] ${username} connected (${socket.id})`);

    // Mark user online in DB (fire and forget)
    supabaseAdmin.from('users')
      .update({ status: 'online', last_seen: new Date().toISOString() })
      .eq('id', userId);

    notifyFriendsPresence(io, userId, 'online');
    io.emit('online:count', online.size);

    registerMatchHandlers(io, socket, userId);
    registerCallHandlers(io, socket, userId, username);
    registerChatHandlers(io, socket, userId, username);
    registerGlobalChatHandlers(io, socket, userId);
    registerSwipeHandlers(io, socket, userId);

    // ── PRESENCE ──────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      clearRateLimitsFor(socket);
      online.delete(userId);
      dequeue(userId);
      clearUserRoom(io, userId);
      supabaseAdmin.from('users')
        .update({ status: 'offline', last_seen: new Date().toISOString() })
        .eq('id', userId);
      notifyFriendsPresence(io, userId, 'offline');
      io.emit('online:count', online.size);
      console.log(`[socket] ${username} disconnected`);
    });
  });
}

module.exports = { initSocket };
