"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * OpenAPI spec assembly (swagger-jsdoc).
 *
 * `swagger-jsdoc` and `swagger-ui-express` were already sitting in
 * package.json as dependencies before this — installed, never wired up.
 * This file is the missing piece: it scans every route file under
 * src/routes/ for `@openapi` JSDoc blocks (the auth/* files already had
 * several, fully written, also never connected to anything) and merges
 * them into the base `definition` below into one spec. See src/index.ts
 * for where the resulting spec is actually served.
 *
 * Adding a new endpoint? Add a `@openapi` JSDoc block directly above the
 * `router.METHOD(...)` call in its route file — nothing needs to change
 * here unless you're introducing a genuinely new reusable shape, in which
 * case add it to `components.schemas` below.
 *
 * GLOB PATTERN NOTE (TS-specific): route files live under src/routes/ in
 * TWO shapes — flat (agora.ts, calls.ts, ...) and split-into-a-directory
 * (auth/*.ts, users/*.ts). A single-level `routes/*.ts` glob (which is all
 * the original JS version needed) would silently miss every @openapi
 * block inside auth/ and users/. Using `routes/**\/*` (recursive) instead
 * catches both shapes. It's also listed for both .ts and .js: swagger-jsdoc
 * only reads these files as text to regex out comments (never executes
 * them), so this works unchanged whether running from src/ via tsx (dev)
 * or from dist/ via node (prod/build) — whichever extension doesn't exist
 * at a given path just matches nothing, harmlessly.
 */
const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');
const packageJson = require('../../package.json');
const definition = {
    openapi: '3.0.3',
    info: {
        title: 'Chalk API',
        version: packageJson.version,
        description: 'REST API for the Chalk backend: auth, profiles, friends, chats (direct/group/global), ' +
            'matchmaking history, voice/video calls, and game leaderboards. Realtime features ' +
            '(live chat delivery, presence, matchmaking itself, calls signaling) go over Socket.io ' +
            'and are intentionally NOT part of this spec — this covers only the plain HTTP surface.',
    },
    // A relative URL resolves against whatever host is actually serving this
    // spec — correct in dev, staging, and production alike without needing
    // a separate "what's my own public URL" env var.
    servers: [{ url: '/', description: 'Current host' }],
    tags: [
        { name: 'Auth', description: 'Registration, login, token refresh, password reset' },
        { name: 'Users', description: 'Profile management, discovery, search, block/report' },
        { name: 'Friends', description: 'Friend requests and friends list' },
        { name: 'Chats', description: 'Direct, group, and global text/media chat' },
        { name: 'Games', description: 'Game scores and leaderboards' },
        { name: 'Match', description: 'Matchmaking history and post-match ratings' },
        { name: 'Calls', description: 'Voice/video call lifecycle logging' },
        { name: 'Agora', description: 'Agora RTC token issuance for active calls' },
    ],
    components: {
        securitySchemes: {
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
                description: 'Access token from /api/auth/login, /register, or /refresh. ' +
                    'Short-lived (15 min) — use the refresh token to get a new one, don\'t re-login.',
            },
        },
        schemas: {
            Error: {
                type: 'object',
                properties: {
                    error: { type: 'string', example: 'Invalid credentials' },
                    details: { type: 'array', items: { type: 'string' }, description: 'Present on some validation (Zod) errors' },
                },
                required: ['error'],
            },
            Ok: {
                type: 'object',
                properties: { ok: { type: 'boolean', example: true } },
            },
            // ── Users ────────────────────────────────────────────────────────
            User: {
                type: 'object',
                description: 'Full "own account" shape — returned only for the authenticated user themself (register/login/refresh/me), includes email.',
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    username: { type: 'string', example: 'ShadowFox_42' },
                    email: { type: 'string', format: 'email' },
                    country: { type: 'string', nullable: true, example: 'NL' },
                    languages: { type: 'array', items: { type: 'string' }, example: ['en', 'ru'] },
                    avatar_emoji: { type: 'string', example: '🎮' },
                    avatar_url: { type: 'string', nullable: true },
                    age: { type: 'integer', nullable: true, example: 24 },
                    gender: { type: 'string', nullable: true, enum: ['male', 'female', 'other', 'prefer_not_to_say'] },
                    bio: { type: 'string', nullable: true },
                    status: { type: 'string', enum: ['online', 'offline'] },
                    presence: { type: 'string', enum: ['online', 'away', 'busy'] },
                    onboarding_completed: { type: 'boolean' },
                    created_at: { type: 'string', format: 'date-time' },
                },
            },
            UserSummary: {
                type: 'object',
                description: 'Lean public shape used in lists and nested references (friends, message senders, search results).',
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    username: { type: 'string' },
                    avatar_emoji: { type: 'string' },
                    avatar_url: { type: 'string', nullable: true },
                    status: { type: 'string', enum: ['online', 'offline'] },
                    presence: { type: 'string', enum: ['online', 'away', 'busy'] },
                },
            },
            UserGame: {
                type: 'object',
                properties: {
                    game_id: { type: 'string' },
                    rank: { type: 'string', nullable: true },
                    hours_played: { type: 'integer' },
                    games: {
                        type: 'object',
                        properties: { name: { type: 'string' }, emoji: { type: 'string' } },
                    },
                },
            },
            PublicProfile: {
                type: 'object',
                description: 'Full profile as seen by another user (GET /api/users/{id}). blocked_by_me/has_blocked_me are computed fresh per viewer, never cached.',
                allOf: [
                    {
                        type: 'object',
                        properties: {
                            id: { type: 'string', format: 'uuid' },
                            username: { type: 'string' },
                            country: { type: 'string', nullable: true },
                            languages: { type: 'array', items: { type: 'string' } },
                            avatar_emoji: { type: 'string' },
                            avatar_url: { type: 'string', nullable: true },
                            age: { type: 'integer', nullable: true },
                            gender: { type: 'string', nullable: true },
                            bio: { type: 'string', nullable: true },
                            status: { type: 'string', enum: ['online', 'offline'] },
                            presence: { type: 'string', enum: ['online', 'away', 'busy'] },
                            last_seen: { type: 'string', format: 'date-time', nullable: true },
                            user_games: { type: 'array', items: { $ref: '#/components/schemas/UserGame' } },
                            blocked_by_me: { type: 'boolean' },
                            has_blocked_me: { type: 'boolean' },
                        },
                    },
                ],
            },
            AuthTokens: {
                type: 'object',
                description: 'Just the token pair, without the user object — returned by /refresh since the caller already has the user\'s profile.',
                properties: {
                    token: { type: 'string', description: 'Access token (JWT), 15 min TTL' },
                    refreshToken: { type: 'string', description: 'Opaque refresh token, 30 day TTL, single-use (rotated on every refresh)' },
                    expiresIn: { type: 'integer', example: 900, description: 'Access token TTL in seconds' },
                },
            },
            AuthResponse: {
                type: 'object',
                properties: {
                    user: { $ref: '#/components/schemas/User' },
                    token: { type: 'string', description: 'Access token (JWT), 15 min TTL' },
                    refreshToken: { type: 'string', description: 'Opaque refresh token, 30 day TTL, single-use (rotated on every refresh)' },
                    expiresIn: { type: 'integer', example: 900, description: 'Access token TTL in seconds' },
                },
            },
            UserStats: {
                type: 'object',
                properties: {
                    matches_found: { type: 'integer' },
                    avg_rating: { type: 'number', nullable: true },
                    friends_count: { type: 'integer' },
                },
            },
            // ── Friends ──────────────────────────────────────────────────────
            Friend: {
                type: 'object',
                description: 'A friends-table row normalized so "friend" is always the other person, from the current viewer\'s perspective.',
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    status: { type: 'string', enum: ['pending', 'accepted'] },
                    friend: {
                        allOf: [
                            { $ref: '#/components/schemas/UserSummary' },
                            { type: 'object', properties: { last_seen: { type: 'string', format: 'date-time', nullable: true } } },
                        ],
                    },
                    incoming: { type: 'boolean', description: 'true if the current user is the recipient of a pending request' },
                    created_at: { type: 'string', format: 'date-time' },
                },
            },
            FriendRequestRecord: {
                type: 'object',
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    user_a: { type: 'string', format: 'uuid' },
                    user_b: { type: 'string', format: 'uuid' },
                    status: { type: 'string', enum: ['pending', 'accepted'] },
                    created_at: { type: 'string', format: 'date-time' },
                },
            },
            // ── Chats ────────────────────────────────────────────────────────
            Conversation: {
                type: 'object',
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    type: { type: 'string', enum: ['direct', 'group'] },
                    name: { type: 'string', nullable: true },
                    other_user: { allOf: [{ $ref: '#/components/schemas/UserSummary' }], nullable: true, description: 'Only present for type=direct' },
                    last_message: { $ref: '#/components/schemas/Message' },
                    created_at: { type: 'string', format: 'date-time' },
                },
            },
            Message: {
                type: 'object',
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    sender_id: { type: 'string', format: 'uuid' },
                    text: { type: 'string', nullable: true },
                    type: { type: 'string', enum: ['text', 'gif', 'voice', 'video_note', 'youtube'] },
                    media_url: { type: 'string', nullable: true },
                    duration_seconds: { type: 'integer', nullable: true },
                    preview_title: { type: 'string', nullable: true },
                    preview_url: { type: 'string', nullable: true },
                    preview_thumbnail: { type: 'string', nullable: true },
                    edited_at: { type: 'string', format: 'date-time', nullable: true },
                    deleted_at: { type: 'string', format: 'date-time', nullable: true },
                    created_at: { type: 'string', format: 'date-time' },
                    sender: { $ref: '#/components/schemas/UserSummary' },
                },
            },
            // ── Games / Match ────────────────────────────────────────────────
            LeaderboardEntry: {
                type: 'object',
                properties: {
                    rank: { type: 'integer' },
                    userId: { type: 'string', format: 'uuid' },
                    username: { type: 'string' },
                    avatarEmoji: { type: 'string' },
                    bestScore: { type: 'integer' },
                    gamesPlayed: { type: 'integer' },
                },
            },
            MatchHistoryEntry: {
                type: 'object',
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    mode: { type: 'string', enum: ['solo', 'group'] },
                    created_at: { type: 'string', format: 'date-time' },
                    games: { type: 'object', nullable: true, properties: { name: { type: 'string' }, emoji: { type: 'string' } } },
                    user_a_profile: { $ref: '#/components/schemas/UserSummary' },
                    user_b_profile: { $ref: '#/components/schemas/UserSummary' },
                },
            },
            // ── Calls ────────────────────────────────────────────────────────
            Call: {
                type: 'object',
                properties: {
                    id: { type: 'string', format: 'uuid' },
                    initiated_by: { type: 'string', format: 'uuid' },
                    participants: { type: 'array', items: { type: 'string', format: 'uuid' } },
                    mode: { type: 'string', enum: ['solo', 'group'] },
                    status: { type: 'string', enum: ['active', 'ended'] },
                    started_at: { type: 'string', format: 'date-time' },
                    ended_at: { type: 'string', format: 'date-time', nullable: true },
                    duration_seconds: { type: 'integer', nullable: true },
                },
            },
        },
    },
    // Default for every operation unless a route explicitly overrides it
    // with `security: []` (used on the handful of genuinely public
    // endpoints — register/login/refresh/forgot-password/reset-password).
    security: [{ bearerAuth: [] }],
};
const options = {
    definition,
    apis: [
        path.join(__dirname, '../routes/**/*.ts'),
        path.join(__dirname, '../routes/**/*.js'),
    ],
};
module.exports = swaggerJsdoc(options);
//# sourceMappingURL=swagger.js.map