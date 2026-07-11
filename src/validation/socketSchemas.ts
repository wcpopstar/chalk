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
const isBinaryLike = (v: unknown) =>
  (Buffer.isBuffer(v) || v instanceof Uint8Array || v instanceof ArrayBuffer) &&
  ((v as any).byteLength ?? (v as any).length ?? 0) <= MAX_MEDIA_BYTES;

const mediaBlob = z.union([
  z.custom(isBinaryLike, { message: 'Некорректный или слишком большой медиа-файл' }),
  z.string().max(Math.ceil(MAX_MEDIA_BYTES * 1.4)), // base64 inflates ~1.33x
  z.array(z.number().int().min(0).max(255)).max(MAX_MEDIA_BYTES),
]);

const mimeField = z.string().trim().min(3).max(100).optional();
const durationField = z.number().finite().nonnegative().max(600).optional(); // 10 min cap

const messageText = (max: number) => z.string().trim().min(1).max(max);
const gifUrl = z.string().trim().url().startsWith('https://').max(2000);

// ── E2EE: base64 blobs for direct-chat messages ─────────────────────────────
// Worst case for a 2000-*character* plaintext message is 2000 four-byte
// UTF-8 code points (rare, but emoji-heavy text can get close) = 8000 raw
// bytes; nacl.box() adds a 16-byte Poly1305 tag = 8016 bytes; base64
// inflates that ~1.34x -> ~10750 chars. 12000 covers it with headroom and
// matches the `messages_text_check` column constraint in
// supabase/migrations/015_e2ee.sql — keep these two in sync. nonce is a
// fixed 24 raw bytes -> exactly 32 base64 chars (24 is divisible by 3, so
// no padding). Public keys are a fixed 32 raw bytes -> base64 of 40-44
// chars depending on padding.
const base64Field = (min: number, max: number) =>
  z.string().trim().min(min).max(max).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Invalid base64');
const ciphertextField = base64Field(1, 12000);
const nonceField = base64Field(32, 32);

const GAME_IDS = ['valorant', 'csgo', 'dota2', 'lol', 'apex', 'fortnite', 'overwatch2', 'rust', 'minecraft', 'other'];

// ── chat.js (direct/DM conversation) ────────────────────────────────────────
const chatJoin = z.object({ conversationId: uuidField });
const chatLeave = z.object({ conversationId: uuidField });
// E2EE note: direct (1:1) conversations are end-to-end encrypted client-side
// (see public/js/e2ee.js) — the client sends `ciphertext` + `nonce` instead
// of `text`, and the server stores/relays the blob without ever seeing
// plaintext. Group conversations aren't E2EE yet (no group-key scheme), so
// they still send plain `text`. Exactly one of the two shapes must be present.
// z.object(...).refine() returns a ZodEffects wrapper (no .merge() available),
// so this builds the combined shape directly rather than trying to compose
// two object schemas together.
const withEncryptedOrPlainText = <T extends z.ZodRawShape>(baseShape: T, maxPlain: number) =>
  z.object({
    ...baseShape,
    text: messageText(maxPlain).optional(),
    ciphertext: ciphertextField.optional(),
    nonce: nonceField.optional(),
  }).refine(
    (v: { text?: unknown; ciphertext?: unknown; nonce?: unknown }) =>
      (v.text !== undefined) !== (v.ciphertext !== undefined), // exactly one
    { message: 'Provide either text or ciphertext, not both/neither' },
  ).refine(
    (v: { ciphertext?: unknown; nonce?: unknown }) =>
      v.ciphertext === undefined || v.nonce !== undefined,
    { message: 'nonce is required alongside ciphertext' },
  );

// Quoted message (reply) via replyToId. Must belong to the same conversation —
// that's verified server-side in socket/chat.ts, a schema can't know it. It
// lives in the base shape so it works for both plaintext and encrypted sends.
const chatMessage = withEncryptedOrPlainText({ conversationId: uuidField, replyToId: uuidField.optional() }, 2000);
const chatGif = z.object({ conversationId: uuidField, gifUrl });
const chatVoice = z.object({
  conversationId: uuidField, audio: mediaBlob, mime: mimeField, duration: durationField,
});
const chatVideoNote = z.object({
  conversationId: uuidField, video: mediaBlob, mime: mimeField, duration: durationField,
});
const chatEdit = withEncryptedOrPlainText({ conversationId: uuidField, messageId: uuidField }, 2000);
const chatDelete = z.object({ conversationId: uuidField, messageId: uuidField });
// kind distinguishes what the person is composing: plain typing, a voice
// note, or a circular video note — the header shows a different label each.
const chatTyping = z.object({
  conversationId: uuidField,
  kind: z.enum(['typing', 'voice', 'video']).optional(),
});
// "I've seen everything in this conversation up to now" — read receipt.
const chatRead = z.object({ conversationId: uuidField });
// Flip end-to-end encryption on/off for a direct conversation (the lock
// button in the chat header). Enabling requires both members to have keys —
// enforced in socket/chat.ts, a schema can't know that.
const chatE2ee = z.object({ conversationId: uuidField, enabled: z.boolean() });

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
  'chat:read': chatRead,
  'chat:e2ee': chatE2ee,

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

export { socketEventSchemas, GAME_IDS };

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
export type ChatReadPayload = z.infer<typeof chatRead>;
export type ChatE2eePayload = z.infer<typeof chatE2ee>;

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
  'chat:read': ChatReadPayload;
  'chat:e2ee': ChatE2eePayload;

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
