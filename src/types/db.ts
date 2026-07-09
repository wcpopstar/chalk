// ── Database row shapes ───────────────────────────────────────────────────
// Hand-written interfaces for the Supabase tables this app reads/writes,
// covering the columns the code actually touches. The supabase-js client is
// NOT parameterized with a generated schema (that's a possible next step:
// `supabase gen types typescript`), so query results come back untyped —
// these interfaces are what repositories/services annotate their results
// with to give callers real shapes.
//
// Nullability follows the actual schema: optional profile fields are
// `| null`, timestamps are ISO strings.

export interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash?: string;
  country: string | null;
  languages: string[] | null;
  avatar_emoji: string | null;
  avatar_url: string | null;
  age: number | null;
  gender: string | null;
  bio?: string | null;
  status?: string | null;
  presence?: string | null;
  onboarding_completed: boolean;
  last_seen?: string | null;
  created_at: string;
}

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
}

export interface FriendRow {
  id: string;
  user_a: string;
  user_b: string;
  status: 'pending' | 'accepted';
  created_at?: string;
}

export interface BlockRow {
  id: string;
  blocker_id: string;
  blocked_id: string;
  created_at?: string;
}

export interface MessageRow {
  id: string;
  conversation_id?: string;
  sender_id: string;
  text: string | null;
  type: string;
  media_url: string | null;
  duration_seconds: number | null;
  preview_title?: string | null;
  preview_url?: string | null;
  preview_thumbnail?: string | null;
  preview_video_id?: string | null;
  edited_at?: string | null;
  deleted_at?: string | null;
  created_at: string;
}

export interface CallRow {
  id: string;
  initiated_by: string;
  participants: string[];
  mode: string;
  started_at: string;
  ended_at?: string | null;
  duration_seconds?: number | null;
  status: 'active' | 'ended';
}

export interface PasswordResetRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at?: string;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by?: string | null;
  created_at?: string;
}

export interface SwipeRow {
  id?: string;
  user_id: string;
  target_user_id: string;
  direction: 'left' | 'right' | 'super';
  created_at: string;
}

export interface ReportRow {
  id?: string;
  reporter_id: string;
  reported_id: string;
  reason: string;
  details: string | null;
  created_at?: string;
}

export interface UserGameRow {
  user_id: string;
  game_id: string;
  rank: string | null;
  hours?: number | null;
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
