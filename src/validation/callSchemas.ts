export {};
const { z } = require('zod');

// `calls.mode` has no DB-level CHECK constraint (unlike e.g. messages.type),
// so this bounds shape/length rather than inventing an enum that might
// reject a legitimate value nothing here documents.
const modeField = z.string().trim().min(1).max(30);

const startCallSchema = z.object({
  // calls.id is a UUID column — if the client doesn't supply one the route
  // generates one itself, but a supplied value must already be a valid UUID
  // (previously this would only surface as an opaque Postgres error).
  roomId: z.string().uuid().optional(),
  participants: z.array(z.string().uuid()).min(1).optional(),
  mode: modeField.optional(),
});

const endCallSchema = z.object({
  duration_seconds: z.coerce.number().int().min(0).max(24 * 60 * 60).optional(),
});

module.exports = { startCallSchema, endCallSchema };
