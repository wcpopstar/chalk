const { z } = require('zod');

const targetUserBodySchema = z.object({
  targetUserId: z.string().uuid(),
});

export { targetUserBodySchema };
