import { z } from 'zod';

const targetUserBodySchema = z.object({
  targetUserId: z.string().uuid(),
});

export { targetUserBodySchema };
