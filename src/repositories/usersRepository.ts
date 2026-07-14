import type { UserInsert, UserUpdate } from '../types/db';
import { supabaseAdmin } from '../services/supabase';

/**
 * Repository layer for the `users` table.
 *
 * Rules this file follows (so it stays worth having):
 *  - Every function here maps to exactly one query shape a route actually
 *    needs — named for intent (`findForLogin`, not a generic `find(opts)`).
 *  - No HTTP concerns (no req/res, no status codes) and no cross-table
 *    business rules (e.g. "block also removes the friendship" belongs in
 *    services/blockHelper.js, not here).
 *  - Returns exactly what supabase-js returns ({ data, error }) rather than
 *    throwing, so call sites that already do `if (error) return
 *    res.status(500)...` keep working unchanged — this is a data-access
 *    seam, not a rewrite of error handling.
 */

const FULL_PROFILE_FIELDS =
  'id, username, email, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, presence, created_at, gaming_links, public_key, e2ee_backup_secret, e2ee_backup_nonce, e2ee_backup_salt, e2ee_backup_iters';

// ── register.js ──────────────────────────────────────────────────────────
function existsByEmailOrUsername(email: string, username: string) {
  return supabaseAdmin
    .from('users')
    .select('id')
    .or(`email.eq.${email},username.eq.${username}`)
    .maybeSingle();
}

function existsByUsername(username: string) {
  return supabaseAdmin
    .from('users')
    .select('id')
    .eq('username', username)
    .maybeSingle();
}

function createUser(record: UserInsert, selectFields: string = FULL_PROFILE_FIELDS) {
  return supabaseAdmin.from('users').insert(record).select(selectFields).single();
}

// ── login.js ─────────────────────────────────────────────────────────────
// Login accepts either an email or a nickname in the same field. Emails are
// stored lowercased so we match on the lowercased identifier; usernames are
// matched as-typed. The identifier is validated (email-or-username charset,
// no commas/parens) before it reaches this .or() filter.
function findForLogin(identifier: string) {
  const id = identifier.trim();
  return supabaseAdmin
    .from('users')
    .select(
      'id, username, email, email_verified, password_hash, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, status, status_text, presence, public_key, e2ee_backup_secret, e2ee_backup_nonce, e2ee_backup_salt, e2ee_backup_iters, banned_until, ban_reason'
    )
    .or(`email.eq.${id.toLowerCase()},username.eq.${id}`)
    .maybeSingle();
}

// Lighter lookup for the emailed-code flows (verify-email, login-code,
// request-login-code): enough to mail a code and issue a session, without the
// password hash.
function findForCodeAuth(identifier: string) {
  const id = identifier.trim();
  return supabaseAdmin
    .from('users')
    .select(
      'id, username, email, email_verified, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, status, status_text, presence, public_key, e2ee_backup_secret, e2ee_backup_nonce, e2ee_backup_salt, e2ee_backup_iters, banned_until, ban_reason'
    )
    .or(`email.eq.${id.toLowerCase()},username.eq.${id}`)
    .maybeSingle();
}

function setEmailVerified(userId: string) {
  return supabaseAdmin.from('users').update({ email_verified: true }).eq('id', userId);
}

// ── users/discovery.js: GET /leaderboard ───────────────────────────────────
// Most active users by cumulative time spent in calls, with their rating.
function getCallLeaderboard(limit: number) {
  return supabaseAdmin
    .from('users')
    .select('id, username, avatar_emoji, avatar_url, avg_rating, total_call_seconds, total_calls')
    .gt('total_call_seconds', 0)
    .order('total_call_seconds', { ascending: false })
    .limit(limit);
}

// ── login.js / session.js (logout, logout-all) ──────────────────────────
function setStatus(userId: string, status: string) {
  return supabaseAdmin
    .from('users')
    .update({ status, last_seen: new Date().toISOString() })
    .eq('id', userId);
}

// ── session.js: /refresh ─────────────────────────────────────────────────
function findBasicById(userId: string) {
  return supabaseAdmin.from('users').select('id, username, banned_until, ban_reason').eq('id', userId).maybeSingle();
}

// ── session.js: GET /me ───────────────────────────────────────────────────
function findFullProfileById(userId: string) {
  return supabaseAdmin
    .from('users')
    .select(
      'id, username, email, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, status, status_text, presence, bio, created_at, public_key, e2ee_backup_secret, e2ee_backup_nonce, e2ee_backup_salt, e2ee_backup_iters'
    )
    .eq('id', userId)
    .single();
}

// ── passwordReset.js ─────────────────────────────────────────────────────
function findByEmailForPasswordReset(email: string) {
  return supabaseAdmin.from('users').select('id, email').eq('email', email.toLowerCase()).maybeSingle();
}

function updatePasswordHash(userId: string, passwordHash: string) {
  return supabaseAdmin.from('users').update({ password_hash: passwordHash }).eq('id', userId);
}

// ── users/profile.js ──────────────────────────────────────────────────────
function existsByUsernameExcludingId(username: string, excludeUserId: string) {
  return supabaseAdmin
    .from('users')
    .select('id')
    .eq('username', username)
    .neq('id', excludeUserId)
    .maybeSingle();
}

function updateProfile(userId: string, updates: UserUpdate, selectFields: string) {
  return supabaseAdmin.from('users').update(updates).eq('id', userId).select(selectFields).single();
}

// ── users/discovery.js ────────────────────────────────────────────────────
// Deliberately takes the exact excludeIds/gameFilterIds/limit shape the
// route already builds, rather than trying to be a general-purpose filter
// builder — this is the one query /discover needs, and it stays readable at
// the call site because the params map 1:1 to what the route computed.
function findDiscoverCandidates({ excludeIds, gameFilterIds, limit }: { excludeIds: string[]; gameFilterIds: string[] | null; limit: number }) {
  let query = supabaseAdmin
    .from('users')
    .select(
      `id, username, country, languages, avatar_emoji, avatar_url, age, gender, bio, status, presence,
       user_games ( rank, games ( id, name, emoji ) )`
    )
    .eq('status', 'online')
    .not('id', 'in', `(${excludeIds.join(',')})`)
    .limit(limit);

  if (gameFilterIds) {
    query = query.in('id', gameFilterIds);
  }
  return query;
}

function findByUsernameExact(username: string, excludeUserId: string) {
  return supabaseAdmin
    .from('users')
    .select('id, username, avatar_emoji, avatar_url, status, presence')
    .ilike('username', username)
    .neq('id', excludeUserId)
    .maybeSingle();
}

function searchByUsername(likePattern: string, excludeUserId: string, limit: number) {
  return supabaseAdmin
    .from('users')
    .select('id, username, avatar_emoji, avatar_url, status, presence')
    .ilike('username', likePattern)
    .neq('id', excludeUserId)
    .limit(limit);
}

// ── users/publicProfile.js ────────────────────────────────────────────────
function findPublicProfileById(userId: string) {
  return supabaseAdmin
    .from('users')
    .select(
      `id, username, country, languages, avatar_emoji, avatar_url, age, gender, bio, status, status_text, presence, last_seen, gaming_links, public_key,
       user_games ( game_id, rank, hours_played, games ( name, emoji ) )`
    )
    .eq('id', userId)
    .single();
}

export {
  FULL_PROFILE_FIELDS,
  existsByEmailOrUsername,
  existsByUsername,
  createUser,
  findForLogin,
  findForCodeAuth,
  setEmailVerified,
  getCallLeaderboard,
  setStatus,
  findBasicById,
  findFullProfileById,
  findByEmailForPasswordReset,
  updatePasswordHash,
  existsByUsernameExcludingId,
  updateProfile,
  findDiscoverCandidates,
  findByUsernameExact,
  searchByUsername,
  findPublicProfileById,
};
