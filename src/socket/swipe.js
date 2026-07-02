const { supabaseAdmin } = require('../services/supabase');
const { online } = require('./state');
const { isFlooding } = require('./rateLimit');

// ── SWIPE ─────────────────────────────────────────────────────────────
function registerSwipeHandlers(io, socket, userId) {
  socket.on('swipe', async ({ targetUserId, direction }) => {
    if (isFlooding(socket, 'swipe', 10_000, 40)) {
      return socket.emit('swipe:error', { error: 'Слишком быстро, притормози немного' });
    }
    await supabaseAdmin.from('swipes').upsert({
      user_id:        userId,
      target_user_id: targetUserId,
      direction,
      created_at:     new Date().toISOString(),
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
        const targetSocket = online.get(targetUserId);
        if (targetSocket) io.to(targetSocket).emit('swipe:match', { with: userId });
      }
    }
  });
}

module.exports = { registerSwipeHandlers };
