export {};
const { z } = require('zod');

const submitScoreSchema = z.object({
  score: z.coerce.number().min(0).max(1_000_000),
});

const leaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

module.exports = { submitScoreSchema, leaderboardQuerySchema };
