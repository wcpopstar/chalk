export {};
const { z } = require('zod');

const targetUserBodySchema = z.object({
  targetUserId: z.string().uuid(),
});

module.exports = { targetUserBodySchema };
