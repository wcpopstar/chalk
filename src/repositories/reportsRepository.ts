import { supabaseAdmin } from '../services/supabase';

function create({ id, reporterId, reportedId, reason, details, context, createdAt }: { id: string; reporterId: string; reportedId: string; reason: string; details: string | null; context: string | null; createdAt: string }) {
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

export { create };
