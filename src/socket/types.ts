// ── Socket.IO typing ─────────────────────────────────────────────────────
// Single source of truth for every Socket.IO event this server accepts or
// emits, plus the shape of per-connection data. Everything in src/socket/*
// and src/index.ts should import TypedServer/TypedSocket from here instead
// of using `Server`/`Socket` (or `any`) directly.
//
// This file only contains types — no runtime code, no `require()` — so it
// compiles away to nothing and is safe to `import type` from anywhere,
// including the CommonJS-style (require/module.exports) files that make up
// the rest of this codebase.

import type { Server, Socket } from 'socket.io';
import type { Logger } from 'pino';
import type { ClientToServerPayloadMap } from '../validation/socketSchemas';
import type { QueueTotals } from '../services/matchmakingRedis';
export type { ClientToServerPayloadMap };

// Every event name secureOn() can ever be called with — i.e. every
// Zod-validated client->server event. Deliberately narrower than
// `keyof ClientToServerEvents`: 'auth:refresh' is handled directly in
// authenticate.ts (it must work before Zod-validated "authenticated"
// handling would even apply), has its own richer ack shape, and never goes
// through secureOn(). Keeping secureOn generic over this narrower,
// uniformly-shaped set (rather than the full union) is also what makes its
// internal `socket.on(eventName, handler)` wiring type-check cleanly.
export type SecuredEventName = keyof ClientToServerPayloadMap;

// ── Authenticated user (decoded JWT) ────────────────────────────────────
// Matches the payload minted by signAccessToken()/verifyAccessToken() in
// src/utils/jwt.ts: `{ id, username }` as the custom claims, plus the
// standard registered JWT claims added by jsonwebtoken itself.
export interface JwtPayload {
  id: string;
  username: string;
  iat: number;
  exp: number;
  jti: string;
  iss?: string;
  aud?: string | string[];
}

// ── Per-connection data (`socket.data`) ─────────────────────────────────
// Socket.IO's idiomatic place for arbitrary per-connection state. Populated
// by socketLogger.ts (connectionId, log) and authenticate.ts (user,
// tokenExpiresAt, tokenExpiryTimer) — see those files for exactly when each
// field gets set. `user`/`tokenExpiresAt` are optional because they don't
// exist yet on the socket during the brief window between socketLogger's
// middleware and authenticateSocket's middleware running.
export interface SocketData {
  connectionId: string;
  log: Logger;
  user?: JwtPayload;
  tokenExpiresAt?: number;
  tokenExpiryTimer?: NodeJS.Timeout;
}

// ── Ack helper types ─────────────────────────────────────────────────────
// secureOn() always hands handlers a callable `ack` (a no-op if the client
// didn't pass one — see validation.ts), so handlers can call it
// unconditionally. Most handlers ack with either `{ ok: true }` or
// `{ error: string }`; a few (friends:call_status) ack with a richer,
// event-specific result instead.
export type BasicAck = (response: { ok?: true; error?: string }) => void;

// ── ServerToClientEvents ─────────────────────────────────────────────────
// Every event this server ever `socket.emit()`/`io.emit()`/`io.to().emit()`s
// to a client, with its exact payload shape (derived from src/socket/*.ts —
// see calls.ts, chat.ts, globalChat.ts, match.ts, swipe.ts, state.ts,
// presence.ts, authenticate.ts, index.ts, validation.ts, rateLimit.ts).
export interface ServerToClientEvents {
  // ── auth ──
  'auth:expired': () => void;

  // ── presence / online count ──
  'online:count': (count: number) => void;
  presence: (data: { userId: string; status: 'online' | 'offline'; lastSeen?: string | null }) => void;
  'friend:call_status': (data: { userId: string; inCall: boolean; roomSize: number }) => void;

  // ── rate limiting ──
  'warning:rate_limit_approaching': (data: {
    scope: string;
    event?: string;
    limit: number;
    remaining: number;
    windowMs: number;
  }) => void;
  'error:rate_limit_exceeded': (data: {
    scope: string;
    event?: string;
    limit: number;
    windowMs: number;
    message: string;
  }) => void;
  'socket:error': (data: { event: string; error: string }) => void;

  // ── direct/DM chat ──
  'chat:message': (message: Record<string, any>) => void;
  'chat:message:edited': (message: Record<string, any>) => void;
  'chat:message:deleted': (data: { conversationId: string; messageId: string }) => void;
  'chat:deleted': (data: { conversationId: string }) => void;
  'chat:typing': (data: { conversationId: string; userId: string; username: string; kind: 'typing' | 'voice' | 'video' }) => void;
  'chat:read': (data: { conversationId: string; userId: string; lastReadAt: string }) => void;
  'chat:e2ee': (data: { conversationId: string; enabled: boolean; byUserId: string; byUsername: string }) => void;
  'chat:pinned': (data: { conversationId: string; messageId: string | null; message: Record<string, any> | null; byUserId: string }) => void;
  'chat:reaction': (data: { conversationId: string; messageId: string; reactions: Array<{ emoji: string; user_id: string }> }) => void;
  'chat:blocked': (data: { conversationId: string }) => void;

  // Server (guild) channels
  'server:message': (message: Record<string, any>) => void;
  'server:message:deleted': (data: { channelId: string; messageId: string }) => void;
  'server:typing': (data: { channelId: string; userId: string; username: string }) => void;

  // ── global (platform-wide) chat ──
  'global:message': (message: Record<string, any>) => void;
  'global:message:edited': (message: Record<string, any>) => void;
  'global:message:deleted': (data: { messageId: string }) => void;

  // ── matchmaking / trial calls ──
  'match:searching': (data: { position: number | QueueTotals }) => void;
  'match:cancelled': () => void;
  'match:error': (data: { error: string }) => void;
  'match:found': (data: {
    roomId: string;
    mode: 'solo' | 'group';
    gameId: string;
    participants: Array<{
      userId: string;
      socketId: string;
      username: string | null;
      avatar_emoji: string;
      avatar_url: string | null;
    }>;
  }) => void;
  'match:found_text': (data: {
    conversationId: string;
    gameId: string;
    partner: {
      userId: string | undefined;
      username: string | null;
      avatar_emoji: string;
      avatar_url: string | null;
    };
  }) => void;
  'queue:size': (size: number) => void;
  'trial:voted': (data: { userId: string; vote: 'yes' | 'no' }) => void;
  'trial:result': (data: { promote: boolean }) => void;

  // ── swipe ──
  'swipe:match': (data: { with: string }) => void;
  'swipe:error': (data: { error: string }) => void;

  // ── calls ──
  'call:incoming': (data: {
    roomId: string;
    from: { id: string; username: string; avatar_emoji: string; avatar_url: string | null };
  }) => void;
  'call:invite_failed': (data: { reason: string }) => void;
  'call:accepted': (data: { roomId: string; by: string }) => void;
  'call:rejected': (data: { roomId: string; by: string }) => void;
  'call:ended': (data: { by: string }) => void;
  'call:promoted': (data: { roomId: string; conversationId: string | null }) => void;
  'call:join_failed': (data: { reason: string }) => void;
  'call:join_request_sent': (data: { roomId: string }) => void;
  'call:join_requested': (data: {
    roomId: string;
    from: { id: string; username: string; avatar_emoji: string; avatar_url: string | null };
  }) => void;
  'call:join_rejected': (data: { roomId: string; by: string }) => void;
  'call:join_accepted': (data: { roomId: string; participants: string[] }) => void;
  'call:participant_joined': (data: { roomId: string; userId: string }) => void;
  // In-call shared clipboard + collaborative whiteboard (relayed to the other
  // participants of a call room).
  'call:clipboard': (data: {
    from: string; fromName: string; kind: 'text' | 'link' | 'code' | 'image'; content: string; at: number;
  }) => void;
  'call:draw': (data: {
    from: string; color?: string; width?: number; segments: number[][];
  }) => void;
  'call:draw_clear': (data: { from: string }) => void;
  'call:game': (data: { from: string; fromName: string; game: 'tetris' | 'chess' | 'frontwars'; action: 'invite' | 'accept' | 'decline' | 'move' | 'score' | 'over' | 'quit'; data: Record<string, string | number | boolean> | null }) => void;
  'call:watch': (data: { from: string; fromName: string; action: 'start' | 'play' | 'pause' | 'seek' | 'stop'; provider: 'youtube' | 'twitch' | 'soundcloud' | null; videoId: string | null; t: number | null }) => void;
}

// ── ClientToServerEvents ─────────────────────────────────────────────────
// Built from ClientToServerPayloadMap (inferred straight from the Zod
// schemas in validation/socketSchemas.ts) so the payload types here can
// never drift from what's actually validated at runtime. `auth:refresh` is
// the one client->server event that bypasses secureOn()/Zod entirely (see
// authenticate.ts — it needs to work before a Zod-validated "authenticated"
// pipeline would even apply), so it's added by hand below.
type SecuredClientToServerEvents = {
  [K in keyof ClientToServerPayloadMap]: (
    payload: ClientToServerPayloadMap[K],
    ack: (response: Record<string, any>) => void
  ) => void;
};

export interface ClientToServerEvents extends SecuredClientToServerEvents {
  'auth:refresh': (
    newToken: string,
    ack: (response: { ok: boolean; error?: string; expiresAt?: number }) => void
  ) => void;
}

// ── InterServerEvents ─────────────────────────────────────────────────────
// Custom events sent server-instance-to-server-instance via `io.serverSideEmit()`.
// This app doesn't use that mechanism (cross-instance fan-out for rooms/
// presence/rate-limits already goes through Redis directly — see state.ts,
// rateLimiter.ts, and the @socket.io/redis-adapter wiring in src/index.ts),
// so this is intentionally empty. Add entries here if that ever changes.
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface InterServerEvents {}

// ── Convenience aliases ───────────────────────────────────────────────────
// Use these everywhere instead of the bare `Server`/`Socket` generics.
export type TypedServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
