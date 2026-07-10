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
  'id, username, email, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, presence, created_at';

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
function findForLogin(email: string) {
  return supabaseAdmin
    .from('users')
    .select(
      'id, username, email, password_hash, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, status, presence'
    )
    .eq('email', email.toLowerCase())
    .maybeSingle();
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
  return supabaseAdmin.from('users').select('id, username').eq('id', userId).maybeSingle();
}

// ── session.js: GET /me ───────────────────────────────────────────────────
function findFullProfileById(userId: string) {
  return supabaseAdmin
    .from('users')
    .select(
      'id, username, email, country, languages, avatar_emoji, avatar_url, age, gender, onboarding_completed, status, presence, bio, created_at'
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
      `id, username, country, languages, avatar_emoji, avatar_url, age, gender, bio, status, presence, last_seen,
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
