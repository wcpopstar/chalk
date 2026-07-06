export {};
const { supabaseAdmin } = require('../services/supabase');

function create({ id, reporterId, reportedId, reason, details, context, createdAt }: any) {
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
