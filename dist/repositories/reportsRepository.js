"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { supabaseAdmin } = require('../services/supabase');
function create({ id, reporterId, reportedId, reason, details, context, createdAt }) {
    return supabaseAdmin.from('reports').insert({
        id,
        reporter_id: reporterId,
        reported_id: reportedId,
        reason,
        details,
        context,
        created_at: createdAt,
    });
}
module.exports = { create };
//# sourceMappingURL=reportsRepository.js.map