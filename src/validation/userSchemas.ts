import { z } from 'zod';

const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'];
const PRESENCE_STATES = ['online', 'away', 'busy'];
const REPORT_REASONS = ['harassment', 'hate_speech', 'spam', 'inappropriate_content', 'scam', 'underage', 'other'];

const usernameField = z
  .string()
  .trim()
  .min(3, 'username must be 3-24 characters')
  .max(24, 'username must be 3-24 characters')
  .regex(/^[a-zA-Z0-9 _-]+$/, 'username may only contain letters, numbers, spaces, underscores and hyphens');

// avatar_url is either an inline data: image (the client crops uploads straight
// to base64) or an https URL. It MUST be constrained here: the frontend drops it
// verbatim into `<img src="${url}">`, and combined with CSP's script-src-attr
// 'unsafe-inline' an unchecked value like  x" onerror="steal(localStorage)  is a
// stored XSS that fires for everyone who renders the avatar. Restricting the
// shape at this single choke point neutralizes that for every client.
//
//   * data:image/<png|jpeg|jpg|webp|gif>;base64,<A-Za-z0-9+/=>   — no quotes or
//     angle brackets can appear, so the value can't break out of the attribute.
//   * https://…                                                   — additionally
//     rejected below if it smuggles a quote / < / > / backtick.
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const avatarUrlField = z
  .string()
  .max(1_500_000, 'avatar_url is invalid or too large')
  .refine(
    (v) => DATA_IMAGE_RE.test(v) || (/^https:\/\/[^\s]+$/.test(v) && !/["'<>`]/.test(v)),
    'avatar_url must be a data:image base64 string or an https URL',
  );

// game_id references games.id, which is a TEXT slug ('valorant', 'cs2', ...)
// — NOT a uuid — see supabase/migrations/001_init.sql.
const gameIdField = z.string().trim().min(1).max(50);

const gameEntry = z.object({
  game_id: gameIdField,
  rank: z.string().trim().max(50).nullish(),
  hours_played: z.coerce.number().int().min(0).max(1_000_000).optional(),
  wins: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

// Advanced privacy settings (settings → Безопасность). Flat booleans stored
// as jsonb; a missing key means the default (everything visible).
const privacySchema = z
  .object({
    discoverable: z.boolean().optional(),
    show_age: z.boolean().optional(),
    show_country: z.boolean().optional(),
    show_online: z.boolean().optional(),
  })
  .strict();

// E2EE long-term public key (X25519, 32 raw bytes -> 40-44 base64 chars
// depending on padding). Client-generated, uploaded once on first login and
// again only if the local keypair is ever regenerated (e.g. new device with
// no synced backup — see public/js/e2ee.js). We only ever validate shape
// here, never the content: the server can't and shouldn't judge a public key.
const publicKeyField = z.string().trim().min(40).max(64).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Invalid base64');

// E2EE key backup: the secret key wrapped client-side with a key derived
// from the login password (PBKDF2 -> nacl.secretbox) so it can be restored
// on another device / after localStorage loss. Opaque to the server — shape
// checks only, sizes documented in supabase/migrations/016_e2ee_key_backup.sql.
// The four fields are useless apart, so a .refine() below rejects partial
// uploads (all-or-nothing per request).
const b64Backup = (min: number, max: number) =>
  z.string().trim().min(min).max(max).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Invalid base64');
const E2EE_BACKUP_KEYS = ['e2ee_backup_secret', 'e2ee_backup_nonce', 'e2ee_backup_salt', 'e2ee_backup_iters'] as const;

// Gaming platform handles (NOT urls — the client builds the profile URL from
// the handle, so nobody can smuggle an arbitrary link onto their public
// profile). Empty string clears a handle. Denylist rather than allowlist for
// the charset: Riot ids and PSN names can contain unicode, but nothing here
// may contain characters that could break out of a URL path segment or HTML.
const GAMING_PLATFORMS = ['steam', 'psn', 'xbox', 'valorant', 'faceit', 'twitch'] as const;
const gamingHandle = z.string().trim().max(80).regex(/^[^/\\<>"'`&?\n\r\t]*$/u, 'Handle contains forbidden characters');
const gamingLinksSchema = z
  .object(Object.fromEntries(GAMING_PLATFORMS.map((p) => [p, gamingHandle.optional()])) as Record<
    (typeof GAMING_PLATFORMS)[number],
    z.ZodOptional<typeof gamingHandle>
  >)
  .strict();

// ── PATCH /api/users/me ──────────────────────────────────────────────────
// All fields optional (partial update), but at least one must be present —
// enforced with .refine() since Zod's own "at least one key" isn't built in.
const updateProfileSchema = z
  .object({
    username: usernameField.optional(),
    country: z.string().trim().max(100).optional(),
    languages: z.array(z.string().trim().min(1)).min(1).optional(),
    avatar_emoji: z.string().trim().max(16).optional(),
    avatar_url: avatarUrlField.optional(),
    bio: z.string().trim().max(500).optional(),
    // Free-text custom status the user writes themselves ("го играть"), shown
    // under their name. Empty string clears it (normalised to null at the DB).
    status_text: z.string().trim().max(100).nullable().optional(),
    age: z.coerce.number().int().min(13).max(100).optional(),
    gender: z.enum(GENDERS as any).optional(),
    presence: z.enum(PRESENCE_STATES as any).optional(),
    gaming_links: gamingLinksSchema.optional(),
    privacy: privacySchema.optional(),
    public_key: publicKeyField.optional(),
    e2ee_backup_secret: b64Backup(44, 128).optional(),
    e2ee_backup_nonce: b64Backup(32, 32).optional(),
    e2ee_backup_salt: b64Backup(16, 44).optional(),
    e2ee_backup_iters: z.coerce.number().int().min(100_000).max(10_000_000).optional(),
  })
  .refine((body: Record<string, unknown>) => Object.keys(body).length > 0, { message: 'Nothing to update' })
  .refine(
    (body: Record<string, unknown>) => {
      const present = E2EE_BACKUP_KEYS.filter((k) => body[k] !== undefined).length;
      return present === 0 || present === E2EE_BACKUP_KEYS.length;
    },
    { message: 'E2EE key backup fields must be sent all together' },
  );

// ── POST /api/users/me/onboarding ────────────────────────────────────────
const onboardingSchema = z.object({
  username: usernameField.optional(),
  // The client sends null when no photo was picked during onboarding.
  avatar_url: avatarUrlField.nullish().transform((v) => v ?? undefined),
  age: z.coerce.number().int().min(13).max(100),
  gender: z.enum(GENDERS as any),
  languages: z.array(z.string().trim().min(1)).min(1, 'Pick at least one language'),
  games: z.array(gameEntry).optional(),
});

// ── PUT /api/users/me/games ───────────────────────────────────────────────
const updateGamesSchema = z.object({
  games: z.array(gameEntry),
});

// ── GET /api/users/discover ──────────────────────────────────────────────
const discoverQuerySchema = z.object({
  game_id: gameIdField.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ── GET /api/users/search ────────────────────────────────────────────────
// `exact` is a presence flag (?exact=1), not a real boolean — Zod's
// coerce.boolean() would incorrectly treat "false" as true (JS's
// Boolean("false") === true), so this is deliberately left as a plain
// optional string and checked for truthiness at the call site, same as
// the query param was checked before this schema existed.
const searchQuerySchema = z.object({
  username: z.string().trim().min(1).max(24),
  exact: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

// ── POST /api/users/:id/report ───────────────────────────────────────────
const reportBodySchema = z.object({
  reason: z.enum(REPORT_REASONS as any),
  details: z.string().trim().max(1000).optional(),
  context: z.string().trim().max(50).optional(),
});

export {
  GENDERS,
  PRESENCE_STATES,
  REPORT_REASONS,
  gameIdField,
  updateProfileSchema,
  onboardingSchema,
  updateGamesSchema,
  discoverQuerySchema,
  searchQuerySchema,
  reportBodySchema,
};
