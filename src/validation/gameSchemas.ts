const { z } = require('zod');

const submitScoreSchema = z.object({
  score: z.coerce.number().min(0).max(1_000_000),
});

const leaderboardQuerySchema = z.object({
  // Out-of-range values are clamped into [1, 50] rather than rejected —
  // a client asking for ?limit=9999 gets the max page size, not a 400.
  limit: z.coerce.number().int().default(10).transform((n: number) => Math.min(Math.max(n, 1), 50)),
});

export { submitScoreSchema, leaderboardQuerySchema };
