import { z } from 'zod';

// ── POST /api/stories ─────────────────────────────────────────────────────
// The image rides as a resized-JPEG data URL (same approach as avatar_url —
// the client crops/compresses to a small JPEG before upload, see
// public/js/stories.js). Bounded well under the 2mb express.json() body limit
// and the 2,000,000-char column check in migration 020. We only check the
// data: prefix and size here — never decode/trust the bytes.
// Same base64-image shape as avatar_url (see userSchemas.ts): a bare
// startsWith('data:image/') would still admit  data:image/png,x" onerror=...
// which breaks out of a src="" attribute wherever a story is rendered into
// HTML. Pin the full format so no quote/angle-bracket can survive.
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const storyImageField = z
  .string()
  .trim()
  .min(1)
  .max(1_500_000, 'Изображение слишком большое')
  .regex(DATA_IMAGE_RE, 'Некорректное изображение');

const createStorySchema = z.object({
  image: storyImageField,
  caption: z.string().trim().max(200).optional(),
});

export { createStorySchema };
