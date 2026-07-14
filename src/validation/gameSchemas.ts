import { z } from 'zod';

const submitScoreSchema = z.object({
  score: z.coerce.number().min(0).max(1_000_000),
});

const leaderboardQuerySchema = z.object({
  // Out-of-range values are clamped into [1, 50] rather than rejected —
  // a client asking for ?limit=9999 gets the max page size, not a 400.
  limit: z.coerce.number().int().default(10).transform((n: number) => Math.min(Math.max(n, 1), 50)),
});

// Arcade mini-games that share the generic game_scores table + endpoints
// (/api/games/:game/score, /api/games/:game/leaderboard). Tetris is NOT here:
// it keeps its own dedicated table/route (see games.ts). Any :game outside
// this list 400s in validation before touching the DB.
const ARCADE_GAMES = ['racing', 'g2048', 'battleship', 'typing', 'platformer'] as const;

const gameParamSchema = z.object({
  game: z.enum(ARCADE_GAMES),
});

export { submitScoreSchema, leaderboardQuerySchema, gameParamSchema, ARCADE_GAMES };
