"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { supabaseAdmin } = require('../services/supabase');
function findSwipedTargetIds(userId) {
    return supabaseAdmin.from('swipes').select('target_user_id').eq('user_id', userId);
}
module.exports = { findSwipedTargetIds };
//# sourceMappingURL=swipesRepository.js.map