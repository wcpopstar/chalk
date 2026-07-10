// ── Database row shapes ───────────────────────────────────────────────────
// Row/Insert/Update aliases derived from the schema type in supabase.ts,
// covering the columns the code actually touches. The supabase-js client is
// NOT parameterized with a generated schema (that's a possible next step:
// `supabase gen types typescript`), so query results come back untyped —
// these interfaces are what repositories/services annotate their results
// with to give callers real shapes.
//
// Nullability follows the actual schema: optional profile fields are
// `| null`, timestamps are ISO strings.

import type { Database } from './supabase';

type Tables = Database['public']['Tables'];

export type UserRow = Tables['users']['Row'];
export type UserInsert = Tables['users']['Insert'];
export type UserUpdate = Tables['users']['Update'];
export type FriendRow = Tables['friends']['Row'];
export type BlockRow = Tables['blocks']['Row'];
export type MessageRow = Tables['messages']['Row'];
export type GlobalMessageRow = Tables['global_messages']['Row'];
export type CallRow = Tables['calls']['Row'];
export type PasswordResetRow = Tables['password_resets']['Row'];
export type RefreshTokenRow = Tables['refresh_tokens']['Row'];
export type SwipeRow = Tables['swipes']['Row'];
export type ReportRow = Tables['reports']['Row'];
export type UserGameRow = Tables['user_games']['Row'];

/** The subset of UserRow that is safe to show to other users. */
export interface PublicProfile {
  id: string;
  username: string;
  avatar_emoji: string | null;
  avatar_url: string | null;
  country?: string | null;
  languages?: string[] | null;
  age?: number | null;
  gender?: string | null;
  bio?: string | null;
  status?: string | null;
  /** E2EE long-term public key (base64 X25519), null if the user hasn't
   *  opened a client that generates one yet. Safe to expose — it's the
   *  whole point of a *public* key. */
  public_key?: string | null;
}


/** Generic shape of every awaited supabase-js query result. */
export interface DbResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

export interface DbListResult<T> {
  data: T[] | null;
  error: { message: string; code?: string } | null;
}
