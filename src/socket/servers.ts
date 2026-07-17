import type { TypedServer, TypedSocket } from './types';
import { secureOn } from './validation';
import { resolveContextByChannel, sendChannelMessage, deleteChannelMessage } from '../services/serverMessaging';
import { PERMISSIONS, can, canConnectVoice } from '../services/serverPermissions';
import * as repo from '../repositories/serversRepository';
import { supabaseAdmin } from '../services/supabase';

// ── Realtime for Discord-style server channels ───────────────────────────────
// A client that has the channel open joins the room `server:chan:${channelId}`
// (after a membership + VIEW_CHANNELS check) and thereafter receives every new
// message / deletion / typing signal for it. Sending + deleting reuse the exact
// permission + anti-spam logic the REST route uses (services/serverMessaging.ts)
// so there's a single source of truth; the REST route also broadcasts to the
// same room, so a message sent via either transport reaches everyone live.
function room(channelId: string) { return `server:chan:${channelId}`; }

// ── Voice channel presence ───────────────────────────────────────────────────
// Voice audio itself flows through Agora (channel name `sc-<channelId>`); this
// layer only tracks *who* is connected so the UI can show a live roster. State
// is in-memory (a single app instance): channelId -> (userId -> member info),
// plus the reverse maps needed to clean up on leave/disconnect and to know
// which server room to broadcast a roster change to. A user is in at most one
// voice channel at a time (joining a second leaves the first, like Discord).
interface VoiceMember { userId: string; username: string; avatar_emoji: string; avatar_url: string | null }
const voiceRosters = new Map<string, Map<string, VoiceMember>>(); // channelId -> userId -> member
const channelServer = new Map<string, string>();                  // channelId -> serverId
const socketVoiceChannel = new Map<string, string>();             // socket.id -> channelId

function serverRoom(serverId: string) { return `server:${serverId}`; }
function voiceRoom(channelId: string) { return `server:voice:${channelId}`; }

function rosterArray(channelId: string): VoiceMember[] {
  const m = voiceRosters.get(channelId);
  return m ? Array.from(m.values()) : [];
}

function broadcastRoster(io: TypedServer, serverId: string, channelId: string) {
  io.to(serverRoom(serverId)).emit('server:voice:roster', { serverId, channelId, members: rosterArray(channelId) });
}

// Remove a socket's user from whatever voice channel it was in and tell the
// server room. Safe to call unconditionally (no-op if not in one).
function leaveVoicePresence(io: TypedServer, socket: TypedSocket, userId: string) {
  const channelId = socketVoiceChannel.get(socket.id);
  if (!channelId) return;
  socketVoiceChannel.delete(socket.id);
  socket.leave(voiceRoom(channelId));
  const members = voiceRosters.get(channelId);
  if (members) {
    members.delete(userId);
    if (!members.size) voiceRosters.delete(channelId);
  }
  const serverId = channelServer.get(channelId);
  if (serverId) broadcastRoster(io, serverId, channelId);
}

function registerServerHandlers(io: TypedServer, socket: TypedSocket, userId: string, username: string) {
  // Subscribe to a channel's live feed. 404/403 semantics are collapsed to a
  // single "can't join" — the client only needs to know it didn't work.
  secureOn(io, socket, userId, 'server:join', async ({ channelId }, ack) => {
    const r = await resolveContextByChannel(userId, channelId);
    if (!r.ok || !can(r.ctx.mask, PERMISSIONS.VIEW_CHANNELS, r.ctx.isOwner)) {
      ack({ error: 'Cannot join channel' });
      return;
    }
    socket.join(room(channelId));
    ack({ ok: true });
  });

  secureOn(io, socket, userId, 'server:leave', async ({ channelId }) => {
    socket.leave(room(channelId));
  });

  secureOn(io, socket, userId, 'server:message', async ({ channelId, content }, ack) => {
    const result = await sendChannelMessage(userId, channelId, content);
    if (!result.ok) { ack({ error: result.error, retryAfter: result.retryAfter }); return; }
    io.to(room(channelId)).emit('server:message', result.message);
    ack({ ok: true, message: result.message });
  });

  secureOn(io, socket, userId, 'server:delete', async ({ channelId, messageId }, ack) => {
    const result = await deleteChannelMessage(userId, messageId);
    if (!result.ok) { ack({ error: result.error }); return; }
    io.to(room(result.channelId)).emit('server:message:deleted', { channelId: result.channelId, messageId });
    ack({ ok: true });
  });

  // Relay a typing signal to everyone else watching the channel (not self).
  secureOn(io, socket, userId, 'server:typing', async ({ channelId }) => {
    socket.to(room(channelId)).emit('server:typing', { channelId, userId, username });
  });

  // ── Voice channels ──────────────────────────────────────────────────────
  // Subscribe to a server's room so this client receives live voice-roster
  // updates for every voice channel in it. Acks with the current rosters so a
  // freshly-opened server immediately shows who's already talking.
  secureOn(io, socket, userId, 'server:sub', async ({ serverId }, ack) => {
    const { data: server } = await repo.getServerById(serverId);
    if (!server) { ack({ error: 'Server not found' }); return; }
    const { data: member } = await repo.getMember(serverId, userId);
    if (!member || member.is_banned) { ack({ error: 'Not a member' }); return; }
    socket.join(serverRoom(serverId));
    const rosters: Record<string, VoiceMember[]> = {};
    for (const [channelId, sid] of channelServer) {
      if (sid === serverId) rosters[channelId] = rosterArray(channelId);
    }
    ack({ ok: true, rosters });
  });

  // Join a voice channel: verify it's a voice channel the caller may connect
  // to, register their presence, and hand back the Agora channel name to join.
  secureOn(io, socket, userId, 'server:voice:join', async ({ channelId }, ack) => {
    const r = await resolveContextByChannel(userId, channelId);
    if (!r.ok) { ack({ error: 'Cannot join channel' }); return; }
    if (r.ctx.channel.type !== 'voice') { ack({ error: 'Not a voice channel' }); return; }
    if (!canConnectVoice(r.ctx.mask, r.ctx.isOwner)) { ack({ error: 'Missing permission' }); return; }

    // One voice channel at a time — leave any previous one first.
    leaveVoicePresence(io, socket, userId);

    const serverId = r.ctx.server.id;
    const { data: profile } = await supabaseAdmin
      .from('users').select('username, avatar_emoji, avatar_url').eq('id', userId).maybeSingle();
    const member: VoiceMember = {
      userId,
      username: (profile?.username as string) || username,
      avatar_emoji: (profile?.avatar_emoji as string) || '🎮',
      avatar_url: (profile?.avatar_url as string) || null,
    };

    let members = voiceRosters.get(channelId);
    if (!members) { members = new Map(); voiceRosters.set(channelId, members); }
    members.set(userId, member);
    channelServer.set(channelId, serverId);
    socketVoiceChannel.set(socket.id, channelId);
    socket.join(voiceRoom(channelId));

    broadcastRoster(io, serverId, channelId);
    ack({ ok: true, agoraChannel: `sc-${channelId}`, members: rosterArray(channelId) });
  });

  secureOn(io, socket, userId, 'server:voice:leave', async (_payload, ack) => {
    leaveVoicePresence(io, socket, userId);
    ack({ ok: true });
  });

  // Clean up voice presence when the socket drops.
  socket.on('disconnect', () => { leaveVoicePresence(io, socket, userId); });
}

export { registerServerHandlers };
