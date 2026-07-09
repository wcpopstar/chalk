import { z } from 'zod';
const { paginationQuery, isoDateTimeOptional } = require('./common');

const createDirectSchema = z.object({
  targetUserId: z.string().uuid(),
});

const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  memberIds: z.array(z.string().uuid()).min(1, 'memberIds array required'),
});

// GET /api/chats/global/messages and GET /api/chats/:id/messages share the
// same { limit, before } cursor-pagination query shape.
const messagesQuerySchema = paginationQuery({ limit: 50, maxLimit: 100, offset: false }).extend({
  before: isoDateTimeOptional,
});

export { createDirectSchema, createGroupSchema, messagesQuerySchema };
