import { supabaseAdmin } from '../services/supabase';

// Three independent counts for a user's profile stats card. Kept as one
// repository function (rather than three separately-named ones) because
// the route always wants all three together via Promise.all, and they
// share no logic worth splitting apart.
function getUserStats(userId: string) {
  return Promise.all([
    supabaseAdmin
      .from('match_history')
      .select('*', { count: 'exact', head: true })
      .or(`user_a.eq.${userId},user_b.eq.${userId}`),
    // avg_rating is a denormalized column on `users` (migrations/001_init.sql),
    // recalculated on every new rating by POST /api/match/rate. It does NOT
    // exist on `ratings` — asking that table for it made Supabase error out,
    // so this endpoint used to report avg_rating: null for everyone.
    supabaseAdmin.from('users').select('avg_rating').eq('id', userId).maybeSingle(),
    supabaseAdmin
      .from('friends')
      .select('*', { count: 'exact', head: true })
      .or(`user_a.eq.${userId},user_b.eq.${userId}`)
      .eq('status', 'accepted'),
  ]);
}

export { getUserStats };
