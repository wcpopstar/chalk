"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Backward-compatibility shim.
//
// The real implementation moved to src/services/matchmakingRedis.js (queue
// now partitioned per gameId + mode, with per-entry TTL). This file just
// re-exports it so existing `require('./matchmaking')` call sites — e.g.
// src/socket/match.js — keep working unchanged.
module.exports = require('../services/matchmakingRedis');
//# sourceMappingURL=matchmaking.js.map