"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { supabaseAdmin } = require('../services/supabase');
// Three independent counts for a user's profile stats card. Kept as one
// repository function (rather than three separately-named ones) because
// the route always wants all three together via Promise.all, and they
// share no logic worth splitting apart.
function getUserStats(userId) {
    return Promise.all([
        supabaseAdmin
            .from('match_history')
            .select('*', { count: 'exact', head: true })
            .or(`user_a.eq.${userId},user_b.eq.${userId}`),
        supabaseAdmin.from('ratings').select('avg_rating').eq('rated_user_id', userId).maybeSingle(),
        supabaseAdmin
            .from('friends')
            .select('*', { count: 'exact', head: true })
            .or(`user_a.eq.${userId},user_b.eq.${userId}`)
            .eq('status', 'accepted'),
    ]);
}
module.exports = { getUserStats };
//# sourceMappingURL=statsRepository.js.map