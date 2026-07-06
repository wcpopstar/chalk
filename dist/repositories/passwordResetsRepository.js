"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { supabaseAdmin } = require('../services/supabase');
function create({ userId, tokenHash, expiresAt }) {
    return supabaseAdmin.from('password_resets').insert({
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
    });
}
function findByTokenHash(tokenHash) {
    return supabaseAdmin
        .from('password_resets')
        .select('id, user_id, expires_at, used_at')
        .eq('token_hash', tokenHash)
        .maybeSingle();
}
function markUsed(id) {
    return supabaseAdmin.from('password_resets').update({ used_at: new Date().toISOString() }).eq('id', id);
}
module.exports = { create, findByTokenHash, markUsed };
//# sourceMappingURL=passwordResetsRepository.js.map