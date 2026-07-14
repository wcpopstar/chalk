import { z } from 'zod';
import { REGISTRY } from '../services/featureFlags';

const flagKeyParam = z.object({
  key: z.enum(Object.keys(REGISTRY) as any),
});

// Either a plain on/off, or a gradual rollout percentage — not both at once,
// so an admin can't set a flag to a self-contradicting state.
const setFlagBodySchema = z.union([
  z.object({ enabled: z.boolean(), rolloutPercent: z.undefined().optional() }),
  z.object({ rolloutPercent: z.number().int().min(0).max(100), enabled: z.literal(true).optional() }),
]);

export { flagKeyParam, setFlagBodySchema };
