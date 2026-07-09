const { supabaseAdmin } = require('../services/supabase');

function create({ userId, tokenHash, expiresAt }: any) {
  return supabaseAdmin.from('password_resets').insert({
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });
}

function findByTokenHash(tokenHash: any) {
  return supabaseAdmin
    .from('password_resets')
    .select('id, user_id, expires_at, used_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
}

function markUsed(id: any) {
  return supabaseAdmin.from('password_resets').update({ used_at: new Date().toISOString() }).eq('id', id);
}

export { create, findByTokenHash, markUsed };
