const { v4: uuid } = require('uuid');
const { supabaseAdmin } = require('./supabase');

/**
 * True if either user has blocked the other (block is one-directional in
 * storage but always enforced both ways).
 */
async function areUsersBlocked(userIdA, userIdB) {
  if (!userIdA || !userIdB) return false;
  const { data, error } = await supabaseAdmin
    .from('blocks')
    .select('id')
    .or(`and(blocker_id.eq.${userIdA},blocked_id.eq.${userIdB}),and(blocker_id.eq.${userIdB},blocked_id.eq.${userIdA})`)
    .limit(1);
  if (error) { console.error('[areUsersBlocked]', error.message); return false; }
  return !!(data && data.length);
}

/**
 * Blocks `blockedId` on behalf of `blockerId`, and — since you shouldn't
 * stay "friends" with someone you've just blocked — tears down any
 * friendship / pending friend request between the pair in the same call.
 */
async function blockUser(blockerId, blockedId) {
  if (!blockerId || !blockedId) throw new Error('Both user ids are required');
  if (blockerId === blockedId) throw new Error('Cannot block yourself');

  const { error: blockErr } = await supabaseAdmin
    .from('blocks')
    .upsert(
      { id: uuid(), blocker_id: blockerId, blocked_id: blockedId, created_at: new Date().toISOString() },
      { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true }
    );
  if (blockErr) throw blockErr;

  await supabaseAdmin
    .from('friends')
    .delete()
    .or(`and(user_a.eq.${blockerId},user_b.eq.${blockedId}),and(user_a.eq.${blockedId},user_b.eq.${blockerId})`);

  return { ok: true };
}

async function unblockUser(blockerId, blockedId) {
  const { error } = await supabaseAdmin
    .from('blocks')
    .delete()
    .eq('blocker_id', blockerId)
    .eq('blocked_id', blockedId);
  if (error) throw error;
  return { ok: true };
}

module.exports = { areUsersBlocked, blockUser, unblockUser };
