import type { TypedServer, TypedSocket } from './types';
import { supabaseAdmin } from '../services/supabase';
import { dequeue } from '../services/matchmakingRedis';
import { authenticateSocket } from './authenticate';
import { socketLogger, attachUserContext } from './socketLogger';
import { setOnline, removeOnline, onlineCount, clearUserRoom } from './state';
import { clearRateLimitsFor, checkConnectionBudget } from './rateLimit';
import { socketConnectionRateLimiter, disconnectForRateLimit } from './validation';
import { notifyFriendsPresence } from './presence';
import { startMatchLoop, registerMatchHandlers } from './match';
import { registerCallHandlers } from './calls';
import { registerChatHandlers } from './chat';
import { registerGlobalChatHandlers } from './globalChat';
import { registerSwipeHandlers } from './swipe';
import metrics from '../utils/metrics';
import { safeAsync } from '../utils/safeAsync';

// ── Main socket initialiser ───────────────────────────────────────────────
// Each feature area (matchmaking, calls, DM chat, global chat, swipes) lives
// in its own file under src/socket/ and exposes a register*Handlers(io,
// socket, ...) function. This file just wires them all up per connection.
//
// NOTE: online/rooms/userCurrentRoom now live in Redis (see state.js), so
// this server instance is stateless w.r.t. presence/call data — any
// instance behind the load balancer can serve any user.
function initSocket(io: TypedServer) {
  // Attach a correlation id + child logger to every socket first (so even
  // handshakes rejected by the checks below are traceable), then the cheap
  // IP-based flood check (rejects handshake spam before we ever touch a
  // JWT), then real authentication.
  io.use(socketLogger);
  io.use(socketConnectionRateLimiter);
  io.use(authenticateSocket);
  const stopMatchLoop = startMatchLoop(io);

  io.on('connection', async (socket: TypedSocket) => {
    const { id: userId, username } = socket.data.user!;
    attachUserContext(socket, socket.data.user!);
    await setOnline(userId, socket.id);
    socket.join('global');

    socket.data.log.info('Socket connected');
    metrics.socketActiveConnections.inc();

    // ── Overall per-connection event budget (80–100 events / 10s) ────────
    // Deliberately implemented via onAny() rather than inside secureOn():
    // onAny() fires for EVERY incoming event on this socket — including
    // ones with no registered handler at all (e.g. a scripted client
    // sending garbage/typo'd event names to flood the connection) — so
    // this is the one place that actually enforces "events on one
    // connection" as a whole, not just "events secureOn() happens to know
    // about". Checked against Redis so the budget is meaningful even
    // behind a load balancer with several server instances.
    //
    // Note the inherent small race here: Socket.io calls onAny listeners
    // and the specific `socket.on(eventName, ...)` handler synchronously,
    // in the same tick, so this async Redis check can't guarantee it wins
    // the race and blocks the *very* event that pushed the count over the
    // limit — at most one extra event can slip through before the
    // disconnect takes effect. That's an acceptable, standard trade-off for
    // any non-blocking rate limiter; the connection is still closed within
    // the same tick the limit was crossed.
    socket.onAny(async () => {
      const budget = await checkConnectionBudget(socket);
      if (budget.warn) {
        socket.emit('warning:rate_limit_approaching', {
          scope: 'connection',
          limit: budget.limit,
          remaining: budget.remaining,
          windowMs: budget.windowMs,
        });
      }
      if (!budget.allowed) {
        disconnectForRateLimit(socket, {
          scope: 'connection',
          limit: budget.limit,
          windowMs: budget.windowMs,
          message: `Превышен общий лимит событий на соединение (${budget.limit}/${Math.round(budget.windowMs / 1000)}с), соединение закрыто`,
        });
      }
    });

    // Mark user online in DB — deliberately not awaited (fire and forget),
    // but still routed through safeAsync so a failure is logged/reported
    // instead of becoming a bare unhandled rejection with no context.
    safeAsync(
      () => supabaseAdmin.from('users').update({ status: 'online', last_seen: new Date().toISOString() }).eq('id', userId),
      { label: 'mark user online in DB', context: { userId } }
    );

    notifyFriendsPresence(io, userId, 'online');
    io.emit('online:count', await onlineCount());

    registerMatchHandlers(io, socket, userId);
    registerCallHandlers(io, socket, userId, username);
    registerChatHandlers(io, socket, userId, username);
    registerGlobalChatHandlers(io, socket, userId);
    registerSwipeHandlers(io, socket, userId);

    // ── PRESENCE ──────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      metrics.socketActiveConnections.dec();
      clearRateLimitsFor(socket);
      await removeOnline(userId);
      await dequeue(userId);
      await clearUserRoom(io, userId);
      safeAsync(
        () => supabaseAdmin.from('users').update({ status: 'offline', last_seen: new Date().toISOString() }).eq('id', userId),
        { label: 'mark user offline in DB', context: { userId } }
      );
      notifyFriendsPresence(io, userId, 'offline');
      io.emit('online:count', await onlineCount());
      socket.data.log.info('Socket disconnected');
    });
  });

  return { stopMatchLoop };
}

export { initSocket };
