export {};
// NOTE: this is a real (typed) `import`, not `const { z } = require('zod')`,
// specifically so the `z.infer<typeof schema>` types at the bottom of this
// file actually resolve to real object shapes instead of `any`. TypeScript
// compiles this down to a plain `require('zod')` under the hood (same as
// every other file in this codebase, since tsconfig.json has
// "module": "commonjs") — there is no behavioral difference at runtime, and
// the `module.exports = { ... }` assignment below still works exactly as
// before for every existing `require('./socketSchemas')` call site.
import { z } from 'zod';

// ── Shared primitives ───────────────────────────────────────────────────────
// Every id in this app (rooms, conversations, messages) is generated with
// `uuid()` (see socket/match.js, socket/messages.js), so we can validate
// them strictly instead of accepting any string.
const uuidField = z.string().uuid();

// Base64-ish media payloads (voice/video notes) arrive as either a base64
// string or a JS array of byte values (client-dependent), so we accept both
// but still cap the size to stop someone streaming a 500MB "voice note".
const MAX_MEDIA_BYTES = 8 * 1024 * 1024; // 8MB, matches upload limits in media.js
// What socket.io actually hands the server for a client-sent ArrayBuffer
// (see public/js/media-notes.js: `blob.arrayBuffer()` then `socket.emit(...)`)
// is a real Node `Buffer` — which is neither a plain string nor a plain
// Array (`Array.isArray(buffer)` is false), so it's its own branch here.
// The string/array branches stay as a fallback for any client that instead
// sends base64 or a plain byte array.
const isBinaryLike = (v: any) =>
  (Buffer.isBuffer(v) || v instanceof Uint8Array || v instanceof ArrayBuffer) &&
  ((v as any).byteLength ?? (v as any).length ?? 0) <= MAX_MEDIA_BYTES;

const mediaBlob = z.union([
  z.custom(isBinaryLike, { message: 'Некорректный или слишком большой медиа-файл' }),
  z.string().max(Math.ceil(MAX_MEDIA_BYTES * 1.4)), // base64 inflates ~1.33x
  z.array(z.number().int().min(0).max(255)).max(MAX_MEDIA_BYTES),
]);

const mimeField = z.string().trim().min(3).max(100).optional();
const durationField = z.number().finite().nonnegative().max(600).optional(); // 10 min cap

const messageText = (max: any) => z.string().trim().min(1).max(max);
const gifUrl = z.string().trim().url().startsWith('https://').max(2000);

const GAME_IDS = ['valorant', 'csgo', 'dota2', 'lol', 'apex', 'fortnite', 'overwatch2', 'rust', 'minecraft', 'other'];

// ── chat.js (direct/DM conversation) ────────────────────────────────────────
const chatJoin = z.object({ conversationId: uuidField });
const chatLeave = z.object({ conversationId: uuidField });
const chatMessage = z.object({ conversationId: uuidField, text: messageText(2000) });
const chatGif = z.object({ conversationId: uuidField, gifUrl });
const chatVoice = z.object({
  conversationId: uuidField, audio: mediaBlob, mime: mimeField, duration: durationField,
});
const chatVideoNote = z.object({
  conversationId: uuidField, video: mediaBlob, mime: mimeField, duration: durationField,
});
const chatEdit = z.object({ conversationId: uuidField, messageId: uuidField, text: messageText(2000) });
const chatDelete = z.object({ conversationId: uuidField, messageId: uuidField });
const chatTyping = z.object({ conversationId: uuidField });

// ── globalChat.js (public room, shorter text cap than DMs) ──────────────────
const globalMessage = z.object({ text: messageText(500) });
const globalGif = z.object({ gifUrl });
const globalVoice = z.object({ audio: mediaBlob, mime: mimeField, duration: durationField });
const globalVideoNote = z.object({ video: mediaBlob, mime: mimeField, duration: durationField });
const globalEdit = z.object({ messageId: uuidField, text: messageText(500) });
const globalDelete = z.object({ messageId: uuidField });

// ── match.js (matchmaking queue + trial-call voting) ────────────────────────
const matchJoin = z.object({
  gameId: z.string().trim().min(1).max(40), // allow unlisted games, but keep sane bounds
  mode: z.enum(['solo', 'group']).default('solo'),
  squadSize: z.number().int().min(2).max(10).default(2),
  rank: z.string().trim().max(40).optional(),
  rankScore: z.number().finite().min(0).max(100000).default(0),
  languages: z.array(z.string().trim().min(2).max(10)).max(10).default(['en']),
  region: z.string().trim().max(20).default('eu'),
});
const matchLeave = z.undefined().or(z.object({}).strict());
const trialVote = z.object({ roomId: uuidField, vote: z.enum(['yes', 'no']) });

// ── swipe.js ─────────────────────────────────────────────────────────────
const swipe = z.object({
  targetUserId: uuidField,
  direction: z.enum(['left', 'right', 'super']),
});

// ── calls.js ─────────────────────────────────────────────────────────────
const callEnd = z.object({ roomId: uuidField });
const callInvite = z.object({ targetUserId: uuidField, roomId: uuidField });
const callAccept = z.object({ roomId: uuidField, inviterId: uuidField });
const callReject = z.object({ roomId: uuidField, inviterId: uuidField });
const callRequestJoin = z.object({ targetUserId: uuidField });
const callJoinResponse = z.object({ roomId: uuidField, requesterId: uuidField, accept: z.boolean() });
const friendsCallStatus = z.undefined().or(z.object({}).strict());

// ── Registry: event name -> zod schema ──────────────────────────────────────
// Anything not listed here is rejected by default by validateSocketEvent()
// unless explicitly marked "unchecked" — see socket/validation.js.
const socketEventSchemas = {
  'chat:join': chatJoin,
  'chat:leave': chatLeave,
  'chat:message': chatMessage,
  'chat:gif': chatGif,
  'chat:voice': chatVoice,
  'chat:video_note': chatVideoNote,
  'chat:edit': chatEdit,
  'chat:delete': chatDelete,
  'chat:typing': chatTyping,

  'global:message': globalMessage,
  'global:gif': globalGif,
  'global:voice': globalVoice,
  'global:video_note': globalVideoNote,
  'global:edit': globalEdit,
  'global:delete': globalDelete,

  'match:join': matchJoin,
  'match:leave': matchLeave,
  'trial:vote': trialVote,

  swipe,

  'call:end': callEnd,
  'call:invite': callInvite,
  'call:accept': callAccept,
  'call:reject': callReject,
  'call:request_join': callRequestJoin,
  'call:join_response': callJoinResponse,
  'friends:call_status': friendsCallStatus,
};

module.exports = { socketEventSchemas, GAME_IDS };

// ── Inferred payload types ──────────────────────────────────────────────
// These are derived straight from the Zod schemas above via z.infer<>, so
// the schema and the TypeScript type can never drift apart — change a
// schema here and every handler's payload type updates automatically.
// socket/types.ts imports these (as `import type`, fully erased at compile
// time) to build the ClientToServerEvents interface used by secureOn() and
// every register*Handlers(io, socket, ...) function.
export type ChatJoinPayload = z.infer<typeof chatJoin>;
export type ChatLeavePayload = z.infer<typeof chatLeave>;
export type ChatMessagePayload = z.infer<typeof chatMessage>;
export type ChatGifPayload = z.infer<typeof chatGif>;
export type ChatVoicePayload = z.infer<typeof chatVoice>;
export type ChatVideoNotePayload = z.infer<typeof chatVideoNote>;
export type ChatEditPayload = z.infer<typeof chatEdit>;
export type ChatDeletePayload = z.infer<typeof chatDelete>;
export type ChatTypingPayload = z.infer<typeof chatTyping>;

export type GlobalMessagePayload = z.infer<typeof globalMessage>;
export type GlobalGifPayload = z.infer<typeof globalGif>;
export type GlobalVoicePayload = z.infer<typeof globalVoice>;
export type GlobalVideoNotePayload = z.infer<typeof globalVideoNote>;
export type GlobalEditPayload = z.infer<typeof globalEdit>;
export type GlobalDeletePayload = z.infer<typeof globalDelete>;

export type MatchJoinPayload = z.infer<typeof matchJoin>;
export type MatchLeavePayload = z.infer<typeof matchLeave>;
export type TrialVotePayload = z.infer<typeof trialVote>;

export type SwipePayload = z.infer<typeof swipe>;

export type CallEndPayload = z.infer<typeof callEnd>;
export type CallInvitePayload = z.infer<typeof callInvite>;
export type CallAcceptPayload = z.infer<typeof callAccept>;
export type CallRejectPayload = z.infer<typeof callReject>;
export type CallRequestJoinPayload = z.infer<typeof callRequestJoin>;
export type CallJoinResponsePayload = z.infer<typeof callJoinResponse>;
export type FriendsCallStatusPayload = z.infer<typeof friendsCallStatus>;

// Event name -> inferred payload type, keyed identically to
// `socketEventSchemas` above. `keyof ClientToServerPayloadMap` is the
// authoritative list of every Zod-validated client->server event name.
export type ClientToServerPayloadMap = {
  'chat:join': ChatJoinPayload;
  'chat:leave': ChatLeavePayload;
  'chat:message': ChatMessagePayload;
  'chat:gif': ChatGifPayload;
  'chat:voice': ChatVoicePayload;
  'chat:video_note': ChatVideoNotePayload;
  'chat:edit': ChatEditPayload;
  'chat:delete': ChatDeletePayload;
  'chat:typing': ChatTypingPayload;

  'global:message': GlobalMessagePayload;
  'global:gif': GlobalGifPayload;
  'global:voice': GlobalVoicePayload;
  'global:video_note': GlobalVideoNotePayload;
  'global:edit': GlobalEditPayload;
  'global:delete': GlobalDeletePayload;

  'match:join': MatchJoinPayload;
  'match:leave': MatchLeavePayload;
  'trial:vote': TrialVotePayload;

  swipe: SwipePayload;

  'call:end': CallEndPayload;
  'call:invite': CallInvitePayload;
  'call:accept': CallAcceptPayload;
  'call:reject': CallRejectPayload;
  'call:request_join': CallRequestJoinPayload;
  'call:join_response': CallJoinResponsePayload;
  'friends:call_status': FriendsCallStatusPayload;
};
