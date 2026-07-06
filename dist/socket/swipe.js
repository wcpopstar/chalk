"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { supabaseAdmin } = require('../services/supabase');
const { getOnlineSocket } = require('./state');
const { secureOn } = require('./validation');
// ── SWIPE ─────────────────────────────────────────────────────────────
// Goes through secureOn(): global + per-event rate limiting (see
// DEFAULT_RATE_LIMITS in socket/validation.js) and Zod validation of
// { targetUserId, direction } against validation/socketSchemas.js — the
// manual targetUserId/direction checks that used to open this handler are
// now centralized there.
function registerSwipeHandlers(io, socket, userId) {
    const emitSwipeError = (sock, ack, error) => sock.emit('swipe:error', { error });
    secureOn(io, socket, userId, 'swipe', async ({ targetUserId, direction }) => {
        await supabaseAdmin.from('swipes').upsert({
            user_id: userId,
            target_user_id: targetUserId,
            direction,
            created_at: new Date().toISOString(),
        });
        if (direction === 'right' || direction === 'super') {
            const { data: mutual } = await supabaseAdmin
                .from('swipes')
                .select('id')
                .eq('user_id', targetUserId)
                .eq('target_user_id', userId)
                .in('direction', ['right', 'super'])
                .maybeSingle();
            if (mutual) {
                socket.emit('swipe:match', { with: targetUserId });
                const targetSocket = await getOnlineSocket(targetUserId);
                if (targetSocket)
                    io.to(targetSocket).emit('swipe:match', { with: userId });
            }
        }
    }, { onRateLimited: emitSwipeError, onInvalid: emitSwipeError });
}
module.exports = { registerSwipeHandlers };
//# sourceMappingURL=swipe.js.map