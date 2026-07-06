export {};
/**
 * safeAsync — the ONE way this codebase swallows an error on purpose.
 *
 * Before this existed, "best-effort, don't let this fail the caller"
 * operations were handled inconsistently across the codebase:
 *   - some with `catch (_) { /* ignore *\/ }` — completely silent, no way
 *     to know it ever happened short of the feature mysteriously not
 *     working (see: friend presence notifications going out or not).
 *   - one inside a socket handler (calls.ts's friends:call_status) that
 *     caught its own errors LOCALLY, which actually made things worse —
 *     it meant the error never reached secureOn()'s centralized
 *     log+Sentry+metrics handling in socket/validation.ts, and the
 *     handler acked `{}` (silently looking like "no friends in calls")
 *     instead of `{ error }`.
 *   - fire-and-forget Supabase calls (`supabaseAdmin.from(...).update(...)`
 *     with no `await`, no `.catch()`) that relied on the global
 *     process.on('unhandledRejection') handler to eventually notice —
 *     which does work, but with zero context about *which* call failed.
 *
 * safeAsync() is the single replacement for all three: log a structured
 * warning (via the shared logger), report to Sentry, and bump the shared
 * `app_errors_total{source="background"}` counter — every time, the same
 * way, everywhere.
 *
 * Usage — awaited (you want the result, but a failure shouldn't throw):
 *   const ok = await safeAsync(() => somethingThatMightFail(x), {
 *     label: 'notify friends of presence change',
 *     context: { userId },
 *   });
 *
 * Usage — fire-and-forget (you don't want to block on it at all):
 *   safeAsync(() => supabaseAdmin.from('users').update({...}).eq('id', userId), {
 *     label: 'mark user online in DB',
 *     context: { userId },
 *   }); // deliberately not awaited — runs in the background
 *
 * When NOT to use this: if the caller needs to know a specific operation
 * failed so it can respond differently (e.g. return an error to the
 * client), let the error propagate normally instead — swallowing it here
 * would hide it from the caller too, not just from the logs.
 */

const logger = require('./logger');
const Sentry = require('./sentry');
const metrics = require('./metrics');

async function safeAsync(fn: any, { label = 'Background operation', context = {} }: any = {}) {
  try {
    return await fn();
  } catch (err: any) {
    logger.warn({ err, ...context }, `${label} failed (non-fatal, continuing)`);
    Sentry.captureException(err, { tags: { source: 'background', label } });
    metrics.appErrorsTotal.inc({ source: 'background' });
    return undefined;
  }
}

module.exports = { safeAsync };
