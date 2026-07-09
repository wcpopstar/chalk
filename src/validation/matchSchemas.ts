const { z } = require('zod');
const { paginationQuery } = require('./common');
const { gameIdField } = require('./userSchemas');

// ── GET /api/match/history ──────────────────────────────────────────────
const historyQuerySchema = paginationQuery({ limit: 20, maxLimit: 100 });

// ── POST /api/match/record-call ──────────────────────────────────────────
const modeField = z.string().trim().min(1).max(30);

const recordCallSchema = z.object({
  participants: z.array(z.string().uuid()).min(1, 'participants required'),
  mode: modeField.optional(),
  gameId: gameIdField.nullish(),
});

// ── POST /api/match/:matchId/rate ─────────────────────────────────────────
const rateMatchSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(500).optional(),
});

export { historyQuerySchema, recordCallSchema, rateMatchSchema };
