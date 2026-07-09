import { supabaseAdmin } from '../services/supabase';

function create({ userId, tokenHash, expiresAt }: { userId: string; tokenHash: string; expiresAt: string }) {
  return supabaseAdmin.from('password_resets').insert({
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });
}

function findByTokenHash(tokenHash: string) {
  return supabaseAdmin
    .from('password_resets')
    .select('id, user_id, expires_at, used_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
}

function markUsed(id: string) {
  return supabaseAdmin.from('password_resets').update({ used_at: new Date().toISOString() }).eq('id', id);
}

export { create, findByTokenHash, markUsed };
