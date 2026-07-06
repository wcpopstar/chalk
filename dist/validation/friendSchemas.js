"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { z } = require('zod');
const targetUserBodySchema = z.object({
    targetUserId: z.string().uuid(),
});
module.exports = { targetUserBodySchema };
//# sourceMappingURL=friendSchemas.js.map