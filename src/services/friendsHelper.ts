import { v4 as uuid } from 'uuid';
import { supabaseAdmin } from './supabase';

/**
 * Instantly (mutually) befriends two users — used by "add friend during/after
 * a call" and by the trial-call unanimous-promotion flow. No pending state.
 *
 * IMPORTANT: the pair is always stored in a normalised order (smaller id in
 * user_a). This guarantees that no matter which of the two users triggers
 * the insert first — including near-simultaneous calls from both sides
 * during a call — they always race for the *same* row instead of each
 * other inserting (A,B) and (B,A), which used to slip past the
 * UNIQUE(user_a, user_b) constraint and create duplicate friendships.
 */
async function addFriendPairInstant(userIdA: string, userIdB: string) {
  if (!userIdA || !userIdB) throw new Error('Both user ids are required');
  if (userIdA === userIdB) return { ok: false, reason: 'self' };

  const [a, b] = [userIdA, userIdB].sort() as [string, string];

  const { data: existing, error: selectErr } = await supabaseAdmin
    .from('friends')
    .select('id, status')
    .eq('user_a', a)
    .eq('user_b', b)
    .maybeSingle();

  if (selectErr) throw selectErr;

  if (existing) {
    if (existing.status !== 'accepted') {
      const { error: updateErr } = await supabaseAdmin
        .from('friends')
        .update({ status: 'accepted' })
        .eq('id', existing.id);
      if (updateErr) throw updateErr;
    }
    return { ok: true, already: true };
  }

  // ignoreDuplicates lets a concurrent insert from the other participant
  // win the race silently instead of throwing a unique-violation error.
  const { error: upsertErr } = await supabaseAdmin
    .from('friends')
    .upsert(
      { id: uuid(), user_a: a, user_b: b, status: 'accepted', created_at: new Date().toISOString() },
      { onConflict: 'user_a,user_b', ignoreDuplicates: true }
    );

  if (upsertErr) throw upsertErr;
  return { ok: true, already: false };
}

export { addFriendPairInstant };
