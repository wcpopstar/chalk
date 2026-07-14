import { z } from 'zod';

const passwordSchema = z.string().trim().min(8).refine((value: string) => {
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

// Login now accepts a nickname OR an email in the same field. Charset is the
// union of the email and username charsets, deliberately excluding commas and
// parentheses so the value is safe to drop into a PostgREST .or() filter
// (usersRepository.findForLogin). Kept as `email` for request-body
// compatibility with existing clients.
const identifierSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .regex(/^[a-zA-Z0-9 _.@+-]+$/, 'invalid login identifier');

const loginSchema = z.object({
  email: identifierSchema,
  password: z.string().min(1),
});

// 6-digit numeric code as mailed by services/emailCodes.ts.
const emailCodeSchema = z.string().trim().regex(/^\d{6}$/, 'code must be 6 digits');

const requestCodeSchema = z.object({
  identifier: identifierSchema,
});

const verifyCodeSchema = z.object({
  identifier: identifierSchema,
  code: emailCodeSchema,
});

const resendCodeSchema = z.object({
  identifier: identifierSchema,
  purpose: z.enum(['verify_email', 'login']),
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

export {
  registerSchema,
  loginSchema,
  passwordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  identifierSchema,
  requestCodeSchema,
  verifyCodeSchema,
  resendCodeSchema,
};
