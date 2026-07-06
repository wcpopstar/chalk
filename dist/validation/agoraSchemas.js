"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { z } = require('zod');
// The route independently re-checks `channel === 'voice-' + myRoomId`
// server-side (see agora.ts) before ever using this value, so this schema
// is defense-in-depth (bounded shape) rather than the only thing standing
// between the request and a privileged action.
const tokenQuerySchema = z.object({
    channel: z.string().trim().min(1).max(200).default('chalk'),
});
module.exports = { tokenQuerySchema };
//# sourceMappingURL=agoraSchemas.js.map