import { supabaseAdmin } from './supabase';
import loggerBase from '../utils/logger';
const logger = loggerBase.child({ module: 'login-events' });

type LoginMethod = 'password' | 'code' | 'passkey' | '2fa';

interface LoginEventMeta {
  ip?: string | null;
  userAgent?: string | null;
}

// Fire-and-forget: the login journal must never delay or fail a sign-in, so
// callers don't await this and errors only get logged.
function recordLoginEvent(userId: string, method: LoginMethod, success: boolean, meta: LoginEventMeta = {}) {
  supabaseAdmin
    .from('login_events')
    .insert({
      user_id: userId,
      method,
      success,
      ip: meta.ip || null,
      user_agent: meta.userAgent || null,
    })
    .then(({ error }) => {
      if (error) logger.warn({ err: error }, 'Failed to record login event');
    });
}

function findRecentForUser(userId: string, limit = 30) {
  return supabaseAdmin
    .from('login_events')
    .select('id, method, success, ip, user_agent, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export { recordLoginEvent, findRecentForUser };
