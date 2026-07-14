import { z } from 'zod';

// ── POST /api/stories ─────────────────────────────────────────────────────
// The image rides as a resized-JPEG data URL (same approach as avatar_url —
// the client crops/compresses to a small JPEG before upload, see
// public/js/stories.js). Bounded well under the 2mb express.json() body limit
// and the 2,000,000-char column check in migration 020. We only check the
// data: prefix and size here — never decode/trust the bytes.
const storyImageField = z
  .string()
  .trim()
  .min(1)
  .max(1_500_000, 'Изображение слишком большое')
  .startsWith('data:image/', 'Некорректное изображение');

const createStorySchema = z.object({
  image: storyImageField,
  caption: z.string().trim().max(200).optional(),
});

export { createStorySchema };
