import type { TypedServer } from './types';
import { supabaseAdmin } from '../services/supabase';
import { getOnlineSocket } from './state';
import { safeAsync } from '../utils/safeAsync';

// ── Tell online friends about presence change ─────────────────────────────
// Best-effort: a friend not finding out someone came online/offline isn't
// worth failing anything over, but the failure itself must still be
// visible — see safeAsync.ts for why this replaced a silent `catch (_) {}`.
async function notifyFriendsPresence(io: TypedServer, userId: string, status: 'online' | 'offline') {
  await safeAsync(async () => {
    const { data: friendRows } = await supabaseAdmin
      .from('friends')
      .select('user_a, user_b')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .eq('status', 'accepted');

    if (!friendRows) return;

    await Promise.all(friendRows.map(async (row: { user_a: string; user_b: string }) => {
      const friendId = row.user_a === userId ? row.user_b : row.user_a;
      const fSocket = await getOnlineSocket(friendId);
      if (fSocket) io.to(fSocket).emit('presence', { userId, status });
    }));
  }, { label: 'notify friends of presence change', context: { userId, status } });
}

export { notifyFriendsPresence };
