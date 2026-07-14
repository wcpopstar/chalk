import { supabaseAdmin } from '../services/supabase';

function findSwipedTargetIds(userId: string) {
  return supabaseAdmin.from('swipes').select('target_user_id').eq('user_id', userId);
}

// Records a like/pass/letter. direction: 'left' (dislike), 'right' (like),
// 'super' (letter — carries a message). Upsert so re-deciding overwrites.
function recordSwipe(userId: string, targetUserId: string, direction: 'left' | 'right' | 'super', message: string | null) {
  return supabaseAdmin.from('swipes').upsert({
    user_id: userId,
    target_user_id: targetUserId,
    direction,
    message: message || null,
    created_at: new Date().toISOString(),
  });
}

// Did the target already like me (right/super)? Used to detect a mutual match.
function findIncomingLike(fromUserId: string, toUserId: string) {
  return supabaseAdmin
    .from('swipes')
    .select('direction, message')
    .eq('user_id', fromUserId)
    .eq('target_user_id', toUserId)
    .in('direction', ['right', 'super'])
    .maybeSingle();
}

// People who liked me (right/super). Excludes anyone I've already swiped on
// back (so answered likes drop out of the inbox). Newest first.
async function findIncomingLikes(userId: string, limit = 50) {
  const { data: mySwipes } = await supabaseAdmin.from('swipes').select('target_user_id').eq('user_id', userId);
  const answered = new Set((mySwipes || []).map((s) => s.target_user_id));

  const { data, error } = await supabaseAdmin
    .from('swipes')
    .select(
      `user_id, direction, message, created_at,
       liker:users!swipes_user_id_fkey (
         id, username, avatar_emoji, avatar_url, age, gender, country, languages, bio, status, presence, privacy,
         user_games ( game_id, rank, hours_played, wins, games ( id, name, emoji ) )
       )`
    )
    .eq('target_user_id', userId)
    .in('direction', ['right', 'super'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return { data: null, error };
  const filtered = (data || []).filter((r) => r.liker && !answered.has(r.user_id));
  return { data: filtered, error: null };
}

export { findSwipedTargetIds, recordSwipe, findIncomingLike, findIncomingLikes };
