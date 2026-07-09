import { z } from 'zod';

// Every id in this schema is a uuid() from the `uuid` package (see
// register.ts, friends.ts, calls.ts, etc.) — route params referencing one
// of these ids should always be validated as a UUID, not just "a string".
const uuidParam = (name: string = 'id') => z.object({ [name]: z.string().uuid() });

// Shared limit/offset pagination shape. z.coerce.number() turns the raw
// query-string value ("20") into an actual number, and .default(...) means
// routes no longer need `const { limit = 20 } = req.query` — the schema
// already guarantees a number is present.
function paginationQuery({ limit = 20, maxLimit = 100, offset = true }: { limit?: number; maxLimit?: number; offset?: boolean } = {}) {
  const shape: Record<string, z.ZodType> = {
    limit: z.coerce.number().int().min(1).max(maxLimit).default(limit),
  };
  if (offset) shape.offset = z.coerce.number().int().min(0).default(0);
  return z.object(shape);
}

// `before` cursor used by chat message pagination — an ISO timestamp string.
const isoDateTimeOptional = z.string().datetime({ offset: true }).optional();

export { uuidParam, paginationQuery, isoDateTimeOptional };
