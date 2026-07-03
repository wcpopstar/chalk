const crypto = require('crypto');
const { supabaseAdmin } = require('./supabase');
const { generateOpaqueToken, hashOpaqueToken, REFRESH_TOKEN_TTL_MS } = require('../utils/jwt');

class InvalidRefreshTokenError extends Error {}
class TokenReuseError extends Error {}

// ── Issue a brand new refresh token ─────────────────────────────────────────
// Used at login/register (new family) and internally by rotateRefreshToken
// (same family, so the whole lineage can be revoked together).
async function issueRefreshToken(userId, meta = {}, familyId = crypto.randomUUID()) {
  const raw = generateOpaqueToken();
  const tokenHash = hashOpaqueToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();

  const { error } = await supabaseAdmin.from('refresh_tokens').insert({
    user_id: userId,
    token_hash: tokenHash,
    family_id: familyId,
    user_agent: meta.userAgent || null,
    ip: meta.ip || null,
    expires_at: expiresAt,
  });

  if (error) throw error;
  return { raw, familyId, userId };
}

// ── Rotate: exchange a refresh token for a new one ──────────────────────────
// Single-use by design — every successful /refresh call revokes the token it
// was given and issues a new one in its place. If the *same* token is ever
// presented a second time, that's a strong signal it was stolen (the
// legitimate client would already be using the rotated one), so we kill the
// entire family — every session descended from that original login.
async function rotateRefreshToken(rawToken, meta = {}) {
  const tokenHash = hashOpaqueToken(rawToken);

  const { data: row, error } = await supabaseAdmin
    .from('refresh_tokens')
    .select('id, user_id, family_id, revoked_at, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error || !row) {
    throw new InvalidRefreshTokenError('Unknown refresh token');
  }

  if (row.revoked_at) {
    await revokeFamily(row.family_id);
    throw new TokenReuseError('Refresh token reuse detected');
  }

  if (new Date(row.expires_at) < new Date()) {
    throw new InvalidRefreshTokenError('Refresh token expired');
  }

  const { raw: newRaw } = await issueRefreshToken(row.user_id, meta, row.family_id);

  await supabaseAdmin
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString(), replaced_by: hashOpaqueToken(newRaw) })
    .eq('id', row.id);

  return { raw: newRaw, userId: row.user_id, familyId: row.family_id };
}

async function revokeFamily(familyId) {
  await supabaseAdmin
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('family_id', familyId)
    .is('revoked_at', null);
}

// Single-token logout (e.g. "log out this device").
async function revokeRefreshToken(rawToken) {
  const tokenHash = hashOpaqueToken(rawToken);
  await supabaseAdmin
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', tokenHash)
    .is('revoked_at', null);
}

// Global logout (e.g. "log out everywhere" / password reset / compromise response).
async function revokeAllForUser(userId) {
  await supabaseAdmin
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('revoked_at', null);
}

module.exports = {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  revokeFamily,
  InvalidRefreshTokenError,
  TokenReuseError,
};
