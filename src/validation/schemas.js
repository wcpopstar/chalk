const { z } = require('zod');

const passwordSchema = z.string().trim().min(8).refine((value) => {
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasDigit = /\d/.test(value);
  return hasLower && hasUpper && hasDigit;
}, 'Password must be at least 8 characters and include uppercase, lowercase and a number');

const registerSchema = z.object({
  username: z.string().trim().min(3).max(24).optional(),
  email: z.string().trim().email(),
  password: passwordSchema,
  country: z.string().trim().max(100).optional(),
  languages: z.array(z.string().trim()).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

module.exports = { registerSchema, loginSchema, passwordSchema };
