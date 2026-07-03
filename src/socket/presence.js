const { supabaseAdmin } = require('../services/supabase');
const { getOnlineSocket } = require('./state');

// ── Tell online friends about presence change ─────────────────────────────
async function notifyFriendsPresence(io, userId, status) {
  try {
    const { data: friendRows } = await supabaseAdmin
      .from('friends')
      .select('user_a, user_b')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .eq('status', 'accepted');

    if (!friendRows) return;

    await Promise.all(friendRows.map(async (row) => {
      const friendId = row.user_a === userId ? row.user_b : row.user_a;
      const fSocket = await getOnlineSocket(friendId);
      if (fSocket) io.to(fSocket).emit('presence', { userId, status });
    }));
  } catch (_) { /* ignore */ }
}

module.exports = { notifyFriendsPresence };
