import { supabaseAdmin } from '../services/supabase';
import type { Database } from '../types/supabase';

type Tables = Database['public']['Tables'];
export type ServerRow = Tables['servers']['Row'];
export type ServerRoleRow = Tables['server_roles']['Row'];
export type ServerChannelRow = Tables['server_channels']['Row'];
export type ServerMemberRow = Tables['server_members']['Row'];
export type ServerMessageRow = Tables['server_messages']['Row'];
export type ServerInviteRow = Tables['server_invites']['Row'];

/**
 * Repository layer for the Discord-style server tables (migration 023).
 * Same contract as the other repositories: one query per intent, returns
 * supabase-js `{ data, error }`, no HTTP or cross-table business rules (those
 * live in the routes / a service).
 */

// ── Servers ──────────────────────────────────────────────────────────────────
function createServer(record: Tables['servers']['Insert']) {
  return supabaseAdmin.from('servers').insert(record).select('*').single();
}
function getServerById(id: string) {
  return supabaseAdmin.from('servers').select('*').eq('id', id).maybeSingle();
}
function updateServer(id: string, patch: Tables['servers']['Update']) {
  return supabaseAdmin.from('servers').update(patch).eq('id', id).select('*').single();
}
function deleteServer(id: string) {
  return supabaseAdmin.from('servers').delete().eq('id', id);
}
// Servers the user is a (non-banned) member of.
async function listServersForUser(userId: string) {
  const { data: memberships, error } = await supabaseAdmin
    .from('server_members')
    .select('server_id')
    .eq('user_id', userId)
    .eq('is_banned', false);
  if (error) return { data: null, error };
  const ids = (memberships || []).map((m) => m.server_id);
  if (!ids.length) return { data: [], error: null };
  return supabaseAdmin.from('servers').select('*').in('id', ids).order('created_at', { ascending: true });
}

// ── Roles ────────────────────────────────────────────────────────────────────
function createRole(record: Tables['server_roles']['Insert']) {
  return supabaseAdmin.from('server_roles').insert(record).select('*').single();
}
function listRoles(serverId: string) {
  return supabaseAdmin.from('server_roles').select('*').eq('server_id', serverId).order('position', { ascending: false });
}
function getRoleById(id: string) {
  return supabaseAdmin.from('server_roles').select('*').eq('id', id).maybeSingle();
}
function updateRole(id: string, patch: Tables['server_roles']['Update']) {
  return supabaseAdmin.from('server_roles').update(patch).eq('id', id).select('*').single();
}
function deleteRole(id: string) {
  return supabaseAdmin.from('server_roles').delete().eq('id', id);
}
function getDefaultRole(serverId: string) {
  return supabaseAdmin.from('server_roles').select('*').eq('server_id', serverId).eq('is_default', true).maybeSingle();
}

// ── Channels ─────────────────────────────────────────────────────────────────
function createChannel(record: Tables['server_channels']['Insert']) {
  return supabaseAdmin.from('server_channels').insert(record).select('*').single();
}
function listChannels(serverId: string) {
  return supabaseAdmin.from('server_channels').select('*').eq('server_id', serverId).order('position', { ascending: true });
}
function getChannelById(id: string) {
  return supabaseAdmin.from('server_channels').select('*').eq('id', id).maybeSingle();
}
function updateChannel(id: string, patch: Tables['server_channels']['Update']) {
  return supabaseAdmin.from('server_channels').update(patch).eq('id', id).select('*').single();
}
function deleteChannel(id: string) {
  return supabaseAdmin.from('server_channels').delete().eq('id', id);
}

// ── Members ──────────────────────────────────────────────────────────────────
function addMember(record: Tables['server_members']['Insert']) {
  return supabaseAdmin.from('server_members').upsert(record, { onConflict: 'server_id,user_id' }).select('*').single();
}
function getMember(serverId: string, userId: string) {
  return supabaseAdmin.from('server_members').select('*').eq('server_id', serverId).eq('user_id', userId).maybeSingle();
}
function listMembers(serverId: string) {
  return supabaseAdmin
    .from('server_members')
    .select('server_id, user_id, nickname, is_banned, joined_at, users(id, username, avatar_emoji, avatar_url, presence)')
    .eq('server_id', serverId)
    .order('joined_at', { ascending: true });
}
function updateMember(serverId: string, userId: string, patch: Tables['server_members']['Update']) {
  return supabaseAdmin.from('server_members').update(patch).eq('server_id', serverId).eq('user_id', userId).select('*').single();
}
function removeMember(serverId: string, userId: string) {
  return supabaseAdmin.from('server_members').delete().eq('server_id', serverId).eq('user_id', userId);
}

// ── Member ↔ role ────────────────────────────────────────────────────────────
function listMemberRoleIds(serverId: string, userId: string) {
  return supabaseAdmin.from('server_member_roles').select('role_id').eq('server_id', serverId).eq('user_id', userId);
}
// Every member↔role row for a server, so the members UI can show who has what
// without an N+1 query per member.
function listAllMemberRoles(serverId: string) {
  return supabaseAdmin.from('server_member_roles').select('user_id, role_id').eq('server_id', serverId);
}
function assignRole(serverId: string, userId: string, roleId: string) {
  return supabaseAdmin
    .from('server_member_roles')
    .upsert({ server_id: serverId, user_id: userId, role_id: roleId }, { onConflict: 'server_id,user_id,role_id' });
}
function unassignRole(serverId: string, userId: string, roleId: string) {
  return supabaseAdmin.from('server_member_roles').delete().eq('server_id', serverId).eq('user_id', userId).eq('role_id', roleId);
}

/**
 * Resolve BOTH the OR'd permission mask a member has (from all their explicit
 * roles PLUS the server's @everyone role) AND the set of role ids that produced
 * it. The role ids are needed to look up per-channel permission overrides.
 */
async function getMemberRolesAndMask(serverId: string, userId: string): Promise<{ roleIds: string[]; mask: number }> {
  const [{ data: assigned }, { data: def }] = await Promise.all([
    listMemberRoleIds(serverId, userId),
    getDefaultRole(serverId),
  ]);
  const roleIds = new Set((assigned || []).map((r) => r.role_id));
  if (def) roleIds.add(def.id);
  if (!roleIds.size) return { roleIds: [], mask: 0 };
  const ids = Array.from(roleIds);
  const { data: roles } = await supabaseAdmin.from('server_roles').select('permissions').in('id', ids);
  let mask = 0;
  for (const r of roles || []) mask |= Number(r.permissions || 0);
  return { roleIds: ids, mask };
}

/** Back-compat convenience: just the OR'd permission mask. */
async function getMemberPermissionMask(serverId: string, userId: string): Promise<number> {
  return (await getMemberRolesAndMask(serverId, userId)).mask;
}

// ── Per-channel permission overrides ──────────────────────────────────────────
function listChannelOverrides(channelId: string) {
  return supabaseAdmin.from('server_channel_overrides').select('*').eq('channel_id', channelId);
}
// Overrides for a channel that apply to the given role ids (the roles a member
// holds). Empty roleIds short-circuits to no rows.
function listChannelOverridesForRoles(channelId: string, roleIds: string[]) {
  if (!roleIds.length) return Promise.resolve({ data: [] as Tables['server_channel_overrides']['Row'][], error: null });
  return supabaseAdmin.from('server_channel_overrides').select('*').eq('channel_id', channelId).in('role_id', roleIds);
}
function upsertChannelOverride(record: Tables['server_channel_overrides']['Insert']) {
  return supabaseAdmin.from('server_channel_overrides').upsert(record, { onConflict: 'channel_id,role_id' }).select('*').single();
}
function deleteChannelOverride(channelId: string, roleId: string) {
  return supabaseAdmin.from('server_channel_overrides').delete().eq('channel_id', channelId).eq('role_id', roleId);
}

// ── Messages ─────────────────────────────────────────────────────────────────
function createMessage(record: Tables['server_messages']['Insert']) {
  return supabaseAdmin
    .from('server_messages')
    .insert(record)
    .select('id, channel_id, sender_id, content, created_at, edited_at, deleted_at, users(id, username, avatar_emoji, avatar_url)')
    .single();
}
function listMessages(channelId: string, limit = 50, before?: string) {
  let q = supabaseAdmin
    .from('server_messages')
    .select('id, channel_id, sender_id, content, created_at, edited_at, deleted_at, users(id, username, avatar_emoji, avatar_url)')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (before) q = q.lt('created_at', before);
  return q;
}
function getMessageById(id: string) {
  return supabaseAdmin.from('server_messages').select('*').eq('id', id).maybeSingle();
}
function softDeleteMessage(id: string) {
  return supabaseAdmin.from('server_messages').update({ deleted_at: new Date().toISOString() }).eq('id', id).select('*').single();
}
// Most recent message a user sent in a channel — for slow-mode enforcement.
function getLastMessageAt(channelId: string, senderId: string) {
  return supabaseAdmin
    .from('server_messages')
    .select('created_at')
    .eq('channel_id', channelId)
    .eq('sender_id', senderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

// ── Invites ──────────────────────────────────────────────────────────────────
function createInvite(record: Tables['server_invites']['Insert']) {
  return supabaseAdmin.from('server_invites').insert(record).select('*').single();
}
function getInvite(code: string) {
  return supabaseAdmin.from('server_invites').select('*').eq('code', code).maybeSingle();
}
function incrementInviteUses(code: string, current: number) {
  return supabaseAdmin.from('server_invites').update({ uses: current + 1 }).eq('code', code);
}
function listInvites(serverId: string) {
  return supabaseAdmin.from('server_invites').select('*').eq('server_id', serverId).order('created_at', { ascending: false });
}
function deleteInvite(code: string) {
  return supabaseAdmin.from('server_invites').delete().eq('code', code);
}

export {
  createServer, getServerById, updateServer, deleteServer, listServersForUser,
  createRole, listRoles, getRoleById, updateRole, deleteRole, getDefaultRole,
  createChannel, listChannels, getChannelById, updateChannel, deleteChannel,
  addMember, getMember, listMembers, updateMember, removeMember,
  listMemberRoleIds, listAllMemberRoles, assignRole, unassignRole, getMemberPermissionMask, getMemberRolesAndMask,
  listChannelOverrides, listChannelOverridesForRoles, upsertChannelOverride, deleteChannelOverride,
  createMessage, listMessages, getMessageById, softDeleteMessage, getLastMessageAt,
  createInvite, getInvite, incrementInviteUses, listInvites, deleteInvite,
};
