import { supabaseAdmin } from '../services/supabase';

/**
 * Repository for the `email_codes` table — short-lived 6-digit codes mailed
 * to a user for email verification and passwordless login. Mirrors the shape
 * conventions of passwordResetsRepository: only the code *hash* is ever stored
 * or compared, and every function maps to one query a route needs.
 */

// Codes are valid for 15 minutes and allow at most 5 wrong attempts before the
// user must request a fresh one — both enforced in routes/auth/emailCodes.ts.
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

type Purpose = 'verify_email' | 'login';

function create({ userId, purpose, codeHash, expiresAt }: { userId: string; purpose: Purpose; codeHash: string; expiresAt: string }) {
  return supabaseAdmin.from('email_codes').insert({
    user_id: userId,
    purpose,
    code_hash: codeHash,
    expires_at: expiresAt,
  });
}

// The active code is the newest unused one for this (user, purpose).
function findLatestValid(userId: string, purpose: Purpose) {
  return supabaseAdmin
    .from('email_codes')
    .select('id, code_hash, attempts, expires_at, used_at')
    .eq('user_id', userId)
    .eq('purpose', purpose)
    .is('used_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

function markUsed(id: string) {
  return supabaseAdmin.from('email_codes').update({ used_at: new Date().toISOString() }).eq('id', id);
}

function incrementAttempts(id: string, current: number) {
  return supabaseAdmin.from('email_codes').update({ attempts: current + 1 }).eq('id', id);
}

// Marks every outstanding code for (user, purpose) as used, so a freshly
// issued code supersedes any still-valid older ones (a user who requests a
// second code shouldn't have two working codes at once).
function invalidateOutstanding(userId: string, purpose: Purpose) {
  return supabaseAdmin
    .from('email_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('purpose', purpose)
    .is('used_at', null);
}

export { create, findLatestValid, markUsed, incrementAttempts, invalidateOutstanding, CODE_TTL_MS, MAX_ATTEMPTS };
