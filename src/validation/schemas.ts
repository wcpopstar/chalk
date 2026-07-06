export {};
const { z } = require('zod');

const passwordSchema = z.string().trim().min(8).refine((value: any) => {
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasDigit = /\d/.test(value);
  return hasLower && hasUpper && hasDigit;
}, 'Password must be at least 8 characters and include uppercase, lowercase and a number');

const registerSchema = z.object({
  username: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9 _-]+$/, 'username may only contain letters, numbers, spaces, underscores and hyphens').optional(),
  email: z.string().trim().email(),
  password: passwordSchema,
  country: z.string().trim().max(100).optional(),
  languages: z.array(z.string().trim()).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: z.string().trim().email(),
});

// Reuses the same passwordSchema as registration (min 8, upper+lower+digit)
// rather than a separate weaker rule — a password reset shouldn't be able
// to set a WEAKER password than registration requires.
const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

module.exports = { registerSchema, loginSchema, passwordSchema, forgotPasswordSchema, resetPasswordSchema };
