import type { TypedServer, TypedSocket } from './types';
import { secureOn } from './validation';
const { resolveContextByChannel, sendChannelMessage, deleteChannelMessage } = require('../services/serverMessaging');
const { PERMISSIONS, can } = require('../services/serverPermissions');

// ── Realtime for Discord-style server channels ───────────────────────────────
// A client that has the channel open joins the room `server:chan:${channelId}`
// (after a membership + VIEW_CHANNELS check) and thereafter receives every new
// message / deletion / typing signal for it. Sending + deleting reuse the exact
// permission + anti-spam logic the REST route uses (services/serverMessaging.ts)
// so there's a single source of truth; the REST route also broadcasts to the
// same room, so a message sent via either transport reaches everyone live.
function room(channelId: string) { return `server:chan:${channelId}`; }

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
}

export { registerServerHandlers };
