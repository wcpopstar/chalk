// Pure text helpers. No DOM, no i18n, no globals — safe leaf module.

// Masks the local part of an email for display in auth hints: "ab***@x.com".
// Very short local parts (<=2 chars) only reveal the first character.
export function maskEmail(email) {
  if (!email || email.indexOf('@') < 0) return email || '';
  const [name, domain] = email.split('@');
  const shown = name.length <= 2 ? name[0] : `${name.slice(0, 2)}***`;
  return `${shown}@${domain}`;
}
