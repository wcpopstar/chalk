import crypto from 'crypto';
import { supabaseAdmin } from './supabase';
import { generateOpaqueToken, hashOpaqueToken, REFRESH_TOKEN_TTL_MS } from '../utils/jwt';

class InvalidRefreshTokenError extends Error {}
class TokenReuseError extends Error {}

// ── Issue a brand new refresh token ─────────────────────────────────────────
// Used at login/register (new family) and internally by rotateRefreshToken
// (same family, so the whole lineage can be revoked together).
interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

// familyId is annotated `string` rather than left to inference: crypto.randomUUID()
// returns the template literal type `${string}-${string}-...`, which would make
// every caller passing a plain string (e.g. a family_id read back from the DB)
// a type error.
async function issueRefreshToken(userId: string, meta: SessionMeta = {}, familyId: string = crypto.randomUUID()) {
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
// How long after a token is rotated we still tolerate it being presented
// again before treating that as theft. This exists because legitimate
// clients can race themselves: e.g. a deploy drops every open tab's
// connection at once, and two tabs sharing the same localStorage-cached
// refresh token both fire /refresh within milliseconds of each other. The
// loser in that race isn't an attacker — it's the same user, a moment too
// late. Genuine token theft/replay overwhelmingly shows up minutes/hours/
// days later from a different client, well outside this window, so a short
// grace period trades a sliver of reuse-detection precision for not mass-
// logging-out legitimate users on every deploy. (Same trade-off Auth0 and
// Supabase Auth make with their own reuse-interval settings.)
const REUSE_GRACE_MS = 10 * 1000;

async function rotateRefreshToken(rawToken: string, meta: SessionMeta = {}) {
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
    const revokedMsAgo = Date.now() - new Date(row.revoked_at).getTime();
    if (revokedMsAgo >= 0 && revokedMsAgo <= REUSE_GRACE_MS) {
      // Within the grace window: treat as a benign duplicate rotation
      // (see REUSE_GRACE_MS above) rather than theft. Mint another sibling
      // token in the same family instead of touching revoked_at/replaced_by
      // again — the row already correctly records its original rotation.
      const { raw } = await issueRefreshToken(row.user_id, meta, row.family_id);
      return { raw, userId: row.user_id, familyId: row.family_id };
    }
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

async function revokeFamily(familyId: string) {
  await supabaseAdmin
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('family_id', familyId)
    .is('revoked_at', null);
}

// Single-token logout (e.g. "log out this device").
async function revokeRefreshToken(rawToken: string) {
  const tokenHash = hashOpaqueToken(rawToken);
  await supabaseAdmin
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', tokenHash)
    .is('revoked_at', null);
}

// Global logout (e.g. "log out everywhere" / password reset / compromise response).
async function revokeAllForUser(userId: string) {
  await supabaseAdmin
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('revoked_at', null);
}

// ── Device / session management (settings → Устройства) ─────────────────────
// One active (non-revoked, non-expired) row per family = one signed-in device:
// rotation always revokes the old row when minting the next one, so the set of
// active rows maps 1:1 to live sessions.
async function listActiveSessionsForUser(userId: string) {
  return supabaseAdmin
    .from('refresh_tokens')
    .select('id, family_id, token_hash, user_agent, ip, created_at, expires_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });
}

// Revokes one device's session by refresh-token row id — the whole family, so
// the device can't resurrect itself with an in-flight rotated sibling. Scoped
// to userId so nobody can revoke somebody else's session by guessing ids.
async function revokeSessionById(userId: string, sessionId: string) {
  const { data: row } = await supabaseAdmin
    .from('refresh_tokens')
    .select('id, family_id, user_id')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!row) return false;
  await revokeFamily(row.family_id);
  return true;
}

function hashRefreshToken(rawToken: string) {
  return hashOpaqueToken(rawToken);
}

export {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  revokeFamily,
  listActiveSessionsForUser,
  revokeSessionById,
  hashRefreshToken,
  InvalidRefreshTokenError,
  TokenReuseError,
};
