import { z } from 'zod';

// `q` is sent straight through to Giphy as a search term — bounded length
// only (no character allowlist) since Giphy's own search endpoint already
// handles arbitrary free text safely; this is defense against absurdly
// long query strings, not injection (there's no SQL/shell involved).
const gifSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(24).default(12),
});

// The media-proxy URL — shape-checked here, the strict host allowlist lives
// in the route handler (it needs URL parsing, not just a regex).
const gifProxyQuerySchema = z.object({
  url: z.string().trim().url().startsWith('https://').max(2000),
});

export { gifSearchQuerySchema, gifProxyQuerySchema };
