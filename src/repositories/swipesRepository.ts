const { supabaseAdmin } = require('../services/supabase');

function findSwipedTargetIds(userId: string) {
  return supabaseAdmin.from('swipes').select('target_user_id').eq('user_id', userId);
}

export { findSwipedTargetIds };
