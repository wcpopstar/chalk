"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { z } = require('zod');
const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'];
const PRESENCE_STATES = ['online', 'away', 'busy'];
const REPORT_REASONS = ['harassment', 'hate_speech', 'spam', 'inappropriate_content', 'scam', 'underage', 'other'];
const usernameField = z
    .string()
    .trim()
    .min(3, 'username must be 3-24 characters')
    .max(24, 'username must be 3-24 characters')
    .regex(/^[a-zA-Z0-9 _-]+$/, 'username may only contain letters, numbers, spaces, underscores and hyphens');
// avatar_url can be a data: URL (client uploads crop straight to base64), so
// this bounds length rather than requiring a strict URL shape.
const avatarUrlField = z.string().max(1_500_000, 'avatar_url is invalid or too large');
// game_id references games.id, which is a TEXT slug ('valorant', 'cs2', ...)
// — NOT a uuid — see supabase/migrations/001_init.sql.
const gameIdField = z.string().trim().min(1).max(50);
const gameEntry = z.object({
    game_id: gameIdField,
    rank: z.string().trim().max(50).nullish(),
    hours_played: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
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
    age: z.coerce.number().int().min(13).max(100).optional(),
    gender: z.enum(GENDERS).optional(),
    presence: z.enum(PRESENCE_STATES).optional(),
})
    .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
// ── POST /api/users/me/onboarding ────────────────────────────────────────
const onboardingSchema = z.object({
    username: usernameField.optional(),
    avatar_url: avatarUrlField.optional(),
    age: z.coerce.number().int().min(13).max(100),
    gender: z.enum(GENDERS),
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
    reason: z.enum(REPORT_REASONS),
    details: z.string().trim().max(1000).optional(),
    context: z.string().trim().max(50).optional(),
});
module.exports = {
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
//# sourceMappingURL=userSchemas.js.map