/**
 * Shared, transport-agnostic business logic for posting/deleting messages in a
 * server channel — used by BOTH the REST route (routes/servers.ts) and the
 * realtime socket handler (socket/servers.ts) so the permission + anti-spam
 * rules live in exactly one place. Returns plain result objects (no HTTP, no
 * socket) that each caller translates to its own transport.
 */
import * as repo from '../repositories/serversRepository';
import { PERMISSIONS, ALL_PERMISSIONS, can, applyChannelOverrides } from './serverPermissions';
import { checkMessage } from './autoModeration';

export interface MemberContext {
  channel: any;
  server: any;
  isOwner: boolean;
  mask: number;
}

export type Fail = { ok: false; status: number; error: string; retryAfter?: number };
export type Ok<T> = { ok: true } & T;

/**
 * Resolve the caller's context for a channel: the channel + its server, whether
 * they own it, and their effective permission mask. Non-members get 404 (don't
 * leak channel existence). Banned members get 403.
 */
export async function resolveContextByChannel(userId: string, channelId: string): Promise<Ok<{ ctx: MemberContext }> | Fail> {
  const { data: channel } = await repo.getChannelById(channelId);
  if (!channel) return { ok: false, status: 404, error: 'Channel not found' };
  const { data: server } = await repo.getServerById(channel.server_id);
  if (!server) return { ok: false, status: 404, error: 'Channel not found' };
  const { data: member } = await repo.getMember(server.id, userId);
  if (!member) return { ok: false, status: 404, error: 'Channel not found' };
  if (member.is_banned) return { ok: false, status: 403, error: 'You are banned from this server' };
  const isOwner = server.owner_id === userId;
  if (isOwner) return { ok: true, ctx: { channel, server, isOwner, mask: ALL_PERMISSIONS } };

  // Server-wide mask from the member's roles, then narrowed/widened by any
  // per-channel overrides that target one of those roles (see migration 033).
  const { roleIds, mask: baseMask } = await repo.getMemberRolesAndMask(server.id, userId);
  // ADMINISTRATOR bypasses channel overrides entirely, like the owner.
  if ((baseMask & PERMISSIONS.ADMINISTRATOR) !== 0) return { ok: true, ctx: { channel, server, isOwner, mask: ALL_PERMISSIONS } };
  const { data: overrides } = await repo.listChannelOverridesForRoles(channel.id, roleIds);
  const mask = applyChannelOverrides(baseMask, overrides || []);
  return { ok: true, ctx: { channel, server, isOwner, mask } };
}

/** Post a message to a text channel, enforcing permission + slow-mode. */
export async function sendChannelMessage(userId: string, channelId: string, rawContent: unknown): Promise<Ok<{ message: any }> | Fail> {
  const resolved = await resolveContextByChannel(userId, channelId);
  if (!resolved.ok) return resolved;
  const { channel, isOwner, mask } = resolved.ctx;

  if (!can(mask, PERMISSIONS.VIEW_CHANNELS, isOwner) || !can(mask, PERMISSIONS.SEND_MESSAGES, isOwner)) {
    return { ok: false, status: 403, error: 'Missing permission' };
  }
  if (channel.type !== 'text') return { ok: false, status: 400, error: 'Not a text channel' };

  const content = typeof rawContent === 'string' ? rawContent.trim() : '';
  if (!content) return { ok: false, status: 400, error: 'Empty message' };
  if (content.length > 4000) return { ok: false, status: 400, error: 'Message too long' };

  const verdict = await checkMessage(userId, content);
  if (!verdict.ok) return { ok: false, status: 400, error: verdict.error || 'Rejected by auto-moderation' };

  // Per-channel slow-mode (anti-spam). Members who can manage messages bypass
  // it, like Discord.
  if (channel.slow_mode_seconds > 0 && !can(mask, PERMISSIONS.MANAGE_MESSAGES, isOwner)) {
    const { data: last } = await repo.getLastMessageAt(channel.id, userId);
    if (last) {
      const elapsed = (Date.now() - new Date(last.created_at).getTime()) / 1000;
      if (elapsed < channel.slow_mode_seconds) {
        return { ok: false, status: 429, error: 'Slow mode active', retryAfter: Math.ceil(channel.slow_mode_seconds - elapsed) };
      }
    }
  }

  const { data: message, error } = await repo.createMessage({ channel_id: channel.id, sender_id: userId, content });
  if (error || !message) return { ok: false, status: 500, error: 'Could not send message' };
  return { ok: true, message };
}

/** Soft-delete a message: the author, or anyone with MANAGE_MESSAGES. */
export async function deleteChannelMessage(userId: string, messageId: string): Promise<Ok<{ channelId: string }> | Fail> {
  const { data: msg } = await repo.getMessageById(messageId);
  if (!msg) return { ok: false, status: 404, error: 'Message not found' };
  const resolved = await resolveContextByChannel(userId, msg.channel_id);
  if (!resolved.ok) return resolved;
  const { isOwner, mask } = resolved.ctx;

  const isAuthor = msg.sender_id === userId;
  if (!isAuthor && !can(mask, PERMISSIONS.MANAGE_MESSAGES, isOwner)) {
    return { ok: false, status: 403, error: 'Missing permission' };
  }
  const { error } = await repo.softDeleteMessage(msg.id);
  if (error) return { ok: false, status: 500, error: 'Could not delete message' };
  return { ok: true, channelId: msg.channel_id };
}
