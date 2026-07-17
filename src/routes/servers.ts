/**
 * Discord-style servers (guilds) — REST API. MVP scope: text channels, roles
 * with a permission bitmask, members, invites, and spam protection. Voice
 * channels + realtime socket delivery + UI come in later passes.
 *
 * Every write path re-checks the caller's effective permissions server-side
 * (loadContext + requirePerm) — client-side gating only hides dead-end UI.
 * Anti-spam here: per-user rate limiters on the chatty/abusable endpoints,
 * per-channel slow-mode, invite-creation caps, and an is_banned block.
 */
import type { Request, Response } from 'express';
import express from 'express';
const router = express.Router();
import { requireAuth } from '../middleware/auth';
import { userLimiter } from '../middleware/rateLimit';
import loggerBase from '../utils/logger';
const logger = loggerBase.child({ module: 'servers' });
import * as repo from '../repositories/serversRepository';
import { PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, ALL_PERMISSIONS, can } from '../services/serverPermissions';
import { sendChannelMessage, deleteChannelMessage } from '../services/serverMessaging';

router.use(requireAuth);

// ── Rate limiters (anti-spam) ────────────────────────────────────────────────
const createServerLimiter = userLimiter({ windowMs: 60 * 60 * 1000, max: 10, message: 'Слишком много новых серверов, попробуй позже.' });
const messageLimiter       = userLimiter({ windowMs: 10 * 1000, max: 12, message: 'Слишком часто, помедленнее.' });
const inviteLimiter        = userLimiter({ windowMs: 60 * 1000, max: 10, message: 'Слишком много инвайтов, подожди немного.' });
const joinLimiter          = userLimiter({ windowMs: 60 * 1000, max: 20, message: 'Слишком много попыток, подожди немного.' });

// ── Helpers ──────────────────────────────────────────────────────────────────
function bad(res: Response, code: number, error: string) { return res.status(code).json({ error }); }

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
function randomCode(len = 8) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * Load the caller's context for a server: the server row, their membership,
 * whether they own it, and their effective permission mask. Sends 404/403 and
 * returns null if the server is missing or the caller isn't a (non-banned)
 * member. Non-member access is intentionally 404 (don't leak existence).
 */
async function loadContext(req: Request, res: Response, serverId: string) {
  const { data: server } = await repo.getServerById(serverId);
  if (!server) { bad(res, 404, 'Server not found'); return null; }
  const { data: member } = await repo.getMember(serverId, req.user.id);
  if (!member) { bad(res, 404, 'Server not found'); return null; }
  if (member.is_banned) { bad(res, 403, 'You are banned from this server'); return null; }
  const isOwner = server.owner_id === req.user.id;
  const mask = isOwner ? ALL_PERMISSIONS : await repo.getMemberPermissionMask(serverId, req.user.id);
  return { server, member, isOwner, mask };
}

function requirePerm(res: Response, ctx: { mask: number; isOwner: boolean }, perm: number) {
  if (!can(ctx.mask, perm, ctx.isOwner)) { bad(res, 403, 'Missing permission'); return false; }
  return true;
}

// ═══════════════════════════ SERVERS ═══════════════════════════════════════════

// Create a server: also seeds the @everyone role, a #general channel, and the
// owner's membership.
router.post('/', createServerLimiter, async (req: Request, res: Response) => {
  const name = str(req.body?.name);
  if (name.length < 1 || name.length > 60) return bad(res, 400, 'Invalid name');
  const iconEmoji = str(req.body?.iconEmoji).slice(0, 8) || null;

  const { data: server, error } = await repo.createServer({ owner_id: req.user.id, name, icon_emoji: iconEmoji });
  if (error || !server) { logger.error({ error }, 'createServer failed'); return bad(res, 500, 'Could not create server'); }

  await repo.createRole({ server_id: server.id, name: '@everyone', permissions: DEFAULT_EVERYONE_PERMISSIONS, position: 0, is_default: true });
  await repo.addMember({ server_id: server.id, user_id: req.user.id });
  await repo.createChannel({ server_id: server.id, name: 'general', type: 'text', position: 0 });

  return res.status(201).json({ server });
});

// List the servers the caller belongs to.
router.get('/', async (req: Request, res: Response) => {
  const { data, error } = await repo.listServersForUser(req.user.id);
  if (error) return bad(res, 500, 'Could not load servers');
  return res.json({ servers: data || [] });
});

// Server detail: channels + roles + the caller's own permission mask.
router.get('/:id', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  const [{ data: channels }, { data: roles }] = await Promise.all([
    repo.listChannels(ctx.server.id),
    repo.listRoles(ctx.server.id),
  ]);
  return res.json({ server: ctx.server, channels: channels || [], roles: roles || [], myPermissions: ctx.mask, isOwner: ctx.isOwner });
});

router.patch('/:id', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.MANAGE_SERVER)) return;
  const patch: Record<string, unknown> = {};
  if (req.body?.name != null) {
    const name = str(req.body.name);
    if (name.length < 1 || name.length > 60) return bad(res, 400, 'Invalid name');
    patch.name = name;
  }
  if (req.body?.iconEmoji !== undefined) patch.icon_emoji = str(req.body.iconEmoji).slice(0, 8) || null;
  patch.updated_at = new Date().toISOString();
  const { data, error } = await repo.updateServer(ctx.server.id, patch);
  if (error) return bad(res, 500, 'Could not update server');
  return res.json({ server: data });
});

// Only the owner can delete a whole server.
router.delete('/:id', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!ctx.isOwner) return bad(res, 403, 'Only the owner can delete the server');
  const { error } = await repo.deleteServer(ctx.server.id);
  if (error) return bad(res, 500, 'Could not delete server');
  return res.json({ ok: true });
});

// ═══════════════════════════ CHANNELS ══════════════════════════════════════════

router.post('/:id/channels', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.MANAGE_CHANNELS)) return;
  const name = str(req.body?.name);
  if (name.length < 1 || name.length > 60) return bad(res, 400, 'Invalid name');
  const type = req.body?.type === 'voice' ? 'voice' : 'text';
  const slow = Math.max(0, Math.min(21600, Number(req.body?.slowModeSeconds) || 0));
  const { data, error } = await repo.createChannel({ server_id: ctx.server.id, name, type, slow_mode_seconds: slow });
  if (error) return bad(res, 500, 'Could not create channel');
  return res.status(201).json({ channel: data });
});

router.patch('/:id/channels/:channelId', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.MANAGE_CHANNELS)) return;
  const { data: channel } = await repo.getChannelById(req.params.channelId!);
  if (!channel || channel.server_id !== ctx.server.id) return bad(res, 404, 'Channel not found');
  const patch: Record<string, unknown> = {};
  if (req.body?.name != null) {
    const name = str(req.body.name);
    if (name.length < 1 || name.length > 60) return bad(res, 400, 'Invalid name');
    patch.name = name;
  }
  if (req.body?.topic !== undefined) patch.topic = str(req.body.topic).slice(0, 300) || null;
  if (req.body?.slowModeSeconds !== undefined) patch.slow_mode_seconds = Math.max(0, Math.min(21600, Number(req.body.slowModeSeconds) || 0));
  const { data, error } = await repo.updateChannel(channel.id, patch);
  if (error) return bad(res, 500, 'Could not update channel');
  return res.json({ channel: data });
});

router.delete('/:id/channels/:channelId', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.MANAGE_CHANNELS)) return;
  const { data: channel } = await repo.getChannelById(req.params.channelId!);
  if (!channel || channel.server_id !== ctx.server.id) return bad(res, 404, 'Channel not found');
  const { error } = await repo.deleteChannel(channel.id);
  if (error) return bad(res, 500, 'Could not delete channel');
  return res.json({ ok: true });
});

// ── Per-channel permission overrides (who can write / join *this* channel) ────
router.get('/:id/channels/:channelId/overrides', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.MANAGE_CHANNELS)) return;
  const { data: channel } = await repo.getChannelById(req.params.channelId!);
  if (!channel || channel.server_id !== ctx.server.id) return bad(res, 404, 'Channel not found');
  const { data, error } = await repo.listChannelOverrides(channel.id);
  if (error) return bad(res, 500, 'Could not load overrides');
  return res.json({ overrides: data || [] });
});

// Upsert one role's override for a channel. allow/deny are clamped to real
// permission bits; a row that would allow and deny nothing is deleted instead.
router.put('/:id/channels/:channelId/overrides/:roleId', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.MANAGE_CHANNELS)) return;
  const { data: channel } = await repo.getChannelById(req.params.channelId!);
  if (!channel || channel.server_id !== ctx.server.id) return bad(res, 404, 'Channel not found');
  const { data: role } = await repo.getRoleById(req.params.roleId!);
  if (!role || role.server_id !== ctx.server.id) return bad(res, 404, 'Role not found');

  const allow = (Number(req.body?.allow) || 0) & ALL_PERMISSIONS;
  let deny = (Number(req.body?.deny) || 0) & ALL_PERMISSIONS;
  deny &= ~allow; // a bit can't be both allowed and denied — allow wins
  if (allow === 0 && deny === 0) {
    await repo.deleteChannelOverride(channel.id, role.id);
    return res.json({ ok: true, override: null });
  }
  const { data, error } = await repo.upsertChannelOverride({ channel_id: channel.id, role_id: role.id, allow, deny });
  if (error) return bad(res, 500, 'Could not save override');
  return res.json({ ok: true, override: data });
});

// ═══════════════════════════ MESSAGES ══════════════════════════════════════════

router.get('/:id/channels/:channelId/messages', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.VIEW_CHANNELS)) return;
  const { data: channel } = await repo.getChannelById(req.params.channelId!);
  if (!channel || channel.server_id !== ctx.server.id) return bad(res, 404, 'Channel not found');
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  const before = typeof req.query.before === 'string' ? req.query.before : undefined;
  const { data, error } = await repo.listMessages(channel.id, limit, before);
  if (error) return bad(res, 500, 'Could not load messages');
  // Oldest-first for rendering (the query returns newest-first for the limit).
  return res.json({ messages: (data || []).slice().reverse() });
});

// Sending + deleting share their permission/anti-spam logic with the socket
// handler via services/serverMessaging.ts (single source of truth).
router.post('/:id/channels/:channelId/messages', messageLimiter, async (req: Request, res: Response) => {
  const result = await sendChannelMessage(req.user.id, req.params.channelId!, req.body?.content);
  if (!result.ok) {
    const body: Record<string, unknown> = { error: result.error };
    if (result.retryAfter) body.retryAfter = result.retryAfter;
    return res.status(result.status).json(body);
  }
  // Fan out to anyone watching this channel in realtime (see socket/servers.ts).
  const { getIO } = require('../socket/registry');
  getIO()?.to(`server:chan:${req.params.channelId}`).emit('server:message', result.message);
  return res.status(201).json({ message: result.message });
});

router.delete('/:id/messages/:messageId', async (req: Request, res: Response) => {
  const result = await deleteChannelMessage(req.user.id, req.params.messageId!);
  if (!result.ok) return bad(res, result.status, result.error);
  const { getIO } = require('../socket/registry');
  getIO()?.to(`server:chan:${result.channelId}`).emit('server:message:deleted', { channelId: result.channelId, messageId: req.params.messageId });
  return res.json({ ok: true });
});

// ═══════════════════════════ ROLES ═════════════════════════════════════════════

router.post('/:id/roles', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.MANAGE_ROLES)) return;
  const name = str(req.body?.name);
  if (name.length < 1 || name.length > 40) return bad(res, 400, 'Invalid name');
  // You can't grant permissions you don't have yourself (owner/admin excepted).
  let permissions = Number(req.body?.permissions) || 0;
  permissions &= ALL_PERMISSIONS;
  if (!ctx.isOwner && (ctx.mask & PERMISSIONS.ADMINISTRATOR) === 0) permissions &= ctx.mask;
  const color = /^#[0-9a-fA-F]{6}$/.test(str(req.body?.color)) ? str(req.body.color) : null;
  const { data, error } = await repo.createRole({ server_id: ctx.server.id, name, permissions, position: 1, color });
  if (error) return bad(res, 500, 'Could not create role');
  return res.status(201).json({ role: data });
});

router.patch('/:id/roles/:roleId', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.MANAGE_ROLES)) return;
  const { data: role } = await repo.getRoleById(req.params.roleId!);
  if (!role || role.server_id !== ctx.server.id) return bad(res, 404, 'Role not found');
  const patch: Record<string, unknown> = {};
  if (req.body?.name != null) {
    const name = str(req.body.name);
    if (name.length < 1 || name.length > 40) return bad(res, 400, 'Invalid name');
    patch.name = name;
  }
  if (req.body?.color !== undefined) patch.color = /^#[0-9a-fA-F]{6}$/.test(str(req.body.color)) ? str(req.body.color) : null;
  if (req.body?.permissions !== undefined) {
    let permissions = (Number(req.body.permissions) || 0) & ALL_PERMISSIONS;
    if (!ctx.isOwner && (ctx.mask & PERMISSIONS.ADMINISTRATOR) === 0) permissions &= ctx.mask;
    patch.permissions = permissions;
  }
  const { data, error } = await repo.updateRole(role.id, patch);
  if (error) return bad(res, 500, 'Could not update role');
  return res.json({ role: data });
});

router.delete('/:id/roles/:roleId', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.MANAGE_ROLES)) return;
  const { data: role } = await repo.getRoleById(req.params.roleId!);
  if (!role || role.server_id !== ctx.server.id) return bad(res, 404, 'Role not found');
  if (role.is_default) return bad(res, 400, 'Cannot delete the @everyone role');
  const { error } = await repo.deleteRole(role.id);
  if (error) return bad(res, 500, 'Could not delete role');
  return res.json({ ok: true });
});

// ═══════════════════════════ MEMBERS ═══════════════════════════════════════════

router.get('/:id/members', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  const [{ data: members, error }, { data: memberRoles }] = await Promise.all([
    repo.listMembers(ctx.server.id),
    repo.listAllMemberRoles(ctx.server.id),
  ]);
  if (error) return bad(res, 500, 'Could not load members');
  // Fold each member's explicit role ids onto their row so the UI can render
  // role chips + an assign/remove control without a query per member.
  const rolesByUser = new Map<string, string[]>();
  for (const r of memberRoles || []) {
    const list = rolesByUser.get(r.user_id) || [];
    list.push(r.role_id);
    rolesByUser.set(r.user_id, list);
  }
  const enriched = (members || []).map((m: Record<string, unknown>) => ({
    ...m,
    roleIds: rolesByUser.get(m.user_id as string) || [],
    isOwner: m.user_id === ctx.server.owner_id,
  }));
  return res.json({ members: enriched, ownerId: ctx.server.owner_id });
});

// Assign or remove a role from a member.
router.post('/:id/members/:userId/roles', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.MANAGE_ROLES)) return;
  const roleId = str(req.body?.roleId);
  const action = req.body?.action === 'remove' ? 'remove' : 'add';
  const { data: role } = await repo.getRoleById(roleId);
  if (!role || role.server_id !== ctx.server.id) return bad(res, 404, 'Role not found');
  if (role.is_default) return bad(res, 400, 'Cannot assign the @everyone role');
  const { data: target } = await repo.getMember(ctx.server.id, req.params.userId!);
  if (!target) return bad(res, 404, 'Member not found');
  const { error } = action === 'add'
    ? await repo.assignRole(ctx.server.id, req.params.userId!, roleId)
    : await repo.unassignRole(ctx.server.id, req.params.userId!, roleId);
  if (error) return bad(res, 500, 'Could not update member roles');
  return res.json({ ok: true });
});

// Kick or ban a member (ban = kick + is_banned so they can't rejoin).
router.delete('/:id/members/:userId', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  const ban = req.query.ban === 'true';
  if (!requirePerm(res, ctx, ban ? PERMISSIONS.BAN_MEMBERS : PERMISSIONS.KICK_MEMBERS)) return;
  const targetId = req.params.userId!;
  if (targetId === ctx.server.owner_id) return bad(res, 403, 'Cannot remove the owner');
  if (targetId === req.user.id) return bad(res, 400, 'Use leave instead');
  if (ban) {
    await repo.updateMember(ctx.server.id, targetId, { is_banned: true });
  } else {
    await repo.removeMember(ctx.server.id, targetId);
  }
  return res.json({ ok: true });
});

// Leave a server (the owner must delete it instead).
router.post('/:id/leave', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (ctx.isOwner) return bad(res, 400, 'Owner cannot leave — delete the server instead');
  await repo.removeMember(ctx.server.id, req.user.id);
  return res.json({ ok: true });
});

// ═══════════════════════════ INVITES ═══════════════════════════════════════════

router.post('/:id/invites', inviteLimiter, async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.CREATE_INVITE)) return;
  const maxUses = req.body?.maxUses != null ? Math.max(1, Math.min(1000, Number(req.body.maxUses) || 0)) : null;
  const expiresInHours = req.body?.expiresInHours != null ? Math.max(1, Math.min(720, Number(req.body.expiresInHours) || 0)) : null;
  const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString() : null;

  // Retry a couple of times in the (very unlikely) event of a code collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomCode(8);
    const { data, error } = await repo.createInvite({ code, server_id: ctx.server.id, created_by: req.user.id, max_uses: maxUses, expires_at: expiresAt });
    if (!error && data) return res.status(201).json({ invite: data });
  }
  return bad(res, 500, 'Could not create invite');
});

router.get('/:id/invites', async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res, req.params.id!);
  if (!ctx) return;
  if (!requirePerm(res, ctx, PERMISSIONS.MANAGE_SERVER)) return;
  const { data, error } = await repo.listInvites(ctx.server.id);
  if (error) return bad(res, 500, 'Could not load invites');
  return res.json({ invites: data || [] });
});

// Join a server via an invite code.
router.post('/join/:code', joinLimiter, async (req: Request, res: Response) => {
  const code = str(req.params.code);
  const { data: invite } = await repo.getInvite(code);
  if (!invite) return bad(res, 404, 'Invalid invite');
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return bad(res, 410, 'Invite expired');
  if (invite.max_uses != null && invite.uses >= invite.max_uses) return bad(res, 410, 'Invite fully used');

  const { data: existing } = await repo.getMember(invite.server_id, req.user.id);
  if (existing && existing.is_banned) return bad(res, 403, 'You are banned from this server');
  if (!existing) {
    const { error } = await repo.addMember({ server_id: invite.server_id, user_id: req.user.id });
    if (error) return bad(res, 500, 'Could not join server');
    await repo.incrementInviteUses(code, invite.uses);
  }
  const { data: server } = await repo.getServerById(invite.server_id);
  return res.json({ server });
});

export = router;
