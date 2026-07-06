"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { userLimiter } = require('../../middleware/rateLimit');
const { GENDERS, PRESENCE_STATES, REPORT_REASONS } = require('../../validation/userSchemas');
// Only the VIEWER-INDEPENDENT part of a profile lives under this key — see
// GET /:id in publicProfile.ts and utils/cache.ts's header comment for why
// blocked_by_me/has_blocked_me can never be part of a shared cache entry.
const profileCacheKey = (userId) => `user_profile:${userId}`;
// 30s: profile fields change rarely (a nickname/bio/avatar edit), but this
// is one of the most-requested endpoints on the platform (viewed on every
// profile card, match, friend list entry click). Explicitly invalidated in
// profile.ts on every write to a user's own profile, so this TTL is a
// safety net, not the primary freshness mechanism.
const PROFILE_CACHE_TTL_SECONDS = 30;
// Live nickname search fires on nearly every keystroke — generous but capped,
// so someone can't script a flood of substring queries against the DB.
const searchLimiter = userLimiter({ windowMs: 10 * 1000, max: 40, message: 'Слишком много запросов поиска, подожди немного.' });
// Block/report are one-click actions on someone else's profile — cap hard so
// a mash-click (or script) can't hammer the DB or spam report rows.
const moderationLimiter = userLimiter({ windowMs: 60 * 1000, max: 20, message: 'Слишком много действий, подожди немного.' });
module.exports = {
    searchLimiter,
    moderationLimiter,
    // Re-exported from validation/userSchemas.ts (the actual source of truth
    // now — see that file) purely for backward compatibility with anything
    // still importing these three from here instead.
    GENDERS,
    PRESENCE_STATES,
    REPORT_REASONS,
    profileCacheKey,
    PROFILE_CACHE_TTL_SECONDS,
};
//# sourceMappingURL=shared.js.map