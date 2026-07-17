/**
 * Server (guild) permission model — a single source of truth for the bitmask
 * used by server_roles.permissions. A member's effective permissions are the
 * bitwise-OR of every role they hold; ADMINISTRATOR (and being the server
 * owner) short-circuits to "allow everything". Mirror these bit values in any
 * client-side gating (the server still re-checks on every write path — client
 * gating only hides dead-end UI).
 */

export const PERMISSIONS = Object.freeze({
  VIEW_CHANNELS:   1 << 0, // see channels + read history
  SEND_MESSAGES:   1 << 1, // post in text channels
  MANAGE_MESSAGES: 1 << 2, // delete/pin anyone's messages
  MANAGE_CHANNELS: 1 << 3, // create/rename/delete channels, set slow-mode
  MANAGE_ROLES:    1 << 4, // create/edit roles, assign them to members
  KICK_MEMBERS:    1 << 5,
  BAN_MEMBERS:     1 << 6,
  MANAGE_SERVER:   1 << 7, // edit server name/icon
  CREATE_INVITE:   1 << 8,
  ADMINISTRATOR:   1 << 9, // implicitly grants every permission above
  CONNECT_VOICE:   1 << 10, // join voice channels
});

export type PermissionName = keyof typeof PERMISSIONS;

// What the auto-created @everyone role grants: view + chat + voice + invites.
export const DEFAULT_EVERYONE_PERMISSIONS =
  PERMISSIONS.VIEW_CHANNELS | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.CONNECT_VOICE | PERMISSIONS.CREATE_INVITE;

// Every bit — used for the owner and any ADMINISTRATOR role.
export const ALL_PERMISSIONS = Object.values(PERMISSIONS).reduce((acc, b) => acc | b, 0);

/** OR together the masks of the roles a member holds. */
export function combineRoleMasks(masks: Array<number | string | null | undefined>): number {
  let acc = 0;
  for (const m of masks) acc |= Number(m || 0);
  return acc;
}

/**
 * Does this effective mask grant `perm`? ADMINISTRATOR grants everything.
 * `isOwner` also grants everything regardless of roles.
 */
export function can(mask: number, perm: number, isOwner = false): boolean {
  if (isOwner) return true;
  if ((mask & PERMISSIONS.ADMINISTRATOR) !== 0) return true;
  return (mask & perm) === perm;
}

/** May this member connect to (join) voice channels? */
export function canConnectVoice(mask: number, isOwner = false): boolean {
  return can(mask, PERMISSIONS.VIEW_CHANNELS, isOwner) && can(mask, PERMISSIONS.CONNECT_VOICE, isOwner);
}

/**
 * Apply per-channel overrides to a member's server-wide mask, Discord-style:
 * the allow/deny bitmasks of every override row that applies to the member
 * (one per role they hold) are OR'd together, then `effective = (base & ~deny)
 * | allow`.
 *
 * Precedence when the SAME bit is both denied (by one role's override) and
 * allowed (by another's): ALLOW wins — the `| allow` is applied last, so it
 * re-grants a bit that `& ~deny` just cleared. This matches Discord's role-
 * level override resolution (accumulated role denies, then accumulated role
 * allows on top). Practical consequence for admins: a channel deny does NOT
 * lock a bit down if any of the member's other roles has an explicit allow for
 * it — to hard-deny, don't grant it via an override elsewhere.
 */
export function applyChannelOverrides(
  baseMask: number,
  overrides: Array<{ allow?: number | string | null; deny?: number | string | null }>,
): number {
  let allow = 0;
  let deny = 0;
  for (const o of overrides) { allow |= Number(o.allow || 0); deny |= Number(o.deny || 0); }
  return (baseMask & ~deny) | allow;
}

/** Resolve a member's effective mask from their roles + ownership. */
export function effectiveMask(roleMasks: Array<number | string | null | undefined>, isOwner = false): number {
  if (isOwner) return ALL_PERMISSIONS;
  const mask = combineRoleMasks(roleMasks);
  if ((mask & PERMISSIONS.ADMINISTRATOR) !== 0) return ALL_PERMISSIONS;
  return mask;
}
