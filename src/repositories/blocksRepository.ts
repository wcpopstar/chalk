const { supabaseAdmin } = require('../services/supabase');

// All block pairs where userId is either the blocker or the blocked side —
// used by /discover to exclude both directions of a block.
function findPairsInvolving(userId: string) {
  return supabaseAdmin
    .from('blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
}

// Block rows specifically between two given users (either direction) — used
// by the public profile route to compute blocked_by_me / has_blocked_me.
function findPairBetween(userIdA: string, userIdB: string) {
  return supabaseAdmin
    .from('blocks')
    .select('blocker_id, blocked_id')
    .or(`and(blocker_id.eq.${userIdA},blocked_id.eq.${userIdB}),and(blocker_id.eq.${userIdB},blocked_id.eq.${userIdA})`);
}

// True/false query used by services/blockHelper.js's areUsersBlocked().
function existsBetween(userIdA: string, userIdB: string) {
  return supabaseAdmin
    .from('blocks')
    .select('id')
    .or(`and(blocker_id.eq.${userIdA},blocked_id.eq.${userIdB}),and(blocker_id.eq.${userIdB},blocked_id.eq.${userIdA})`)
    .limit(1);
}

// Everyone `blockerId` has blocked, with basic profile info for the "blocked
// users" list in the add-friend modal.
function listBlockedByUser(blockerId: string) {
  return supabaseAdmin
    .from('blocks')
    .select('id, created_at, blocked:users!blocks_blocked_id_fkey ( id, username, avatar_emoji, avatar_url )')
    .eq('blocker_id', blockerId)
    .order('created_at', { ascending: false });
}

function insertBlock({ id, blockerId, blockedId, createdAt }: { id: string; blockerId: string; blockedId: string; createdAt: string }) {
  return supabaseAdmin
    .from('blocks')
    .upsert(
      { id, blocker_id: blockerId, blocked_id: blockedId, created_at: createdAt },
      { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true }
    );
}

function deleteBlock(blockerId: string, blockedId: string) {
  return supabaseAdmin.from('blocks').delete().eq('blocker_id', blockerId).eq('blocked_id', blockedId);
}

export {
  findPairsInvolving,
  findPairBetween,
  existsBetween,
  listBlockedByUser,
  insertBlock,
  deleteBlock,
};
