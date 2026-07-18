import { z } from 'zod';

// ── Chalk AI ──────────────────────────────────────────────────────────────
// POST /api/ai/reply — a voice-call turn. The client keeps the transcript
// (nothing is persisted server-side) and sends the running history each
// request; caps keep one request comfortably inside the model context and
// stop the endpoint being used as a general-purpose LLM proxy.
const aiReplySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(2000),
      })
    )
    .min(1, 'Пустой диалог')
    .max(16, 'Слишком длинная история'),
});

// PUT /api/ai/prefs — the user's personal instructions for the assistant.
// Empty string = reset to default behaviour.
const aiPrefsSchema = z.object({
  instructions: z.string().trim().max(1000, 'Не больше 1000 символов'),
});

export { aiReplySchema, aiPrefsSchema };
