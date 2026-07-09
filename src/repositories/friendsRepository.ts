const { supabaseAdmin } = require('../services/supabase');

// Tears down any friendship/pending request between two users, in either
// direction — used by services/blockHelper.js when a block should also end
// an existing friendship.
function deleteBetween(userIdA: string, userIdB: string) {
  return supabaseAdmin
    .from('friends')
    .delete()
    .or(`and(user_a.eq.${userIdA},user_b.eq.${userIdB}),and(user_a.eq.${userIdB},user_b.eq.${userIdA})`);
}

export { deleteBetween };
