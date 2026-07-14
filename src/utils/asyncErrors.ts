/**
 * asyncErrors — makes `throw` inside async route handlers actually work.
 *
 * Express 4 predates async/await: it only forwards errors to the error
 * middleware when a handler calls `next(err)` or throws SYNCHRONOUSLY.
 * A rejected promise from an `async (req, res) => ...` handler goes
 * nowhere — the request hangs until the client times out, and the error
 * only surfaces via process.on('unhandledRejection') with zero request
 * context (no route, no user, no correlation id). The centralized error
 * handler in src/index.ts — the one place that logs with the request's
 * pino child logger, reports to Sentry, and bumps app_errors_total —
 * never sees it.
 *
 * Every route handler in this codebase is async, and almost none of them
 * wrap their bodies in try/catch (deliberately: supabase-js returns
 * `{ data, error }` instead of throwing, so the happy path doesn't need
 * one). That leaves everything else that CAN throw — a TypeError on an
 * unexpected payload shape, a helper that throws, JSON.parse, a network
 * error from a non-supabase client — falling into the hang-the-request
 * hole above.
 *
 * The fix (same approach as the `express-async-errors` package, inlined
 * here so it's visible and dependency-free): intercept the assignment of
 * every route/middleware function to its router Layer, and wrap it so a
 * returned rejected promise is routed to `next(err)` — exactly as if the
 * handler had called it. Sync behavior, arity (express uses fn.length to
 * distinguish error middleware), and return values are all preserved.
 *
 * MUST be imported before any module that creates a Router (i.e. before
 * the route imports in src/index.ts) — Layers capture their handler at
 * router.get()/use() time, and only assignments made after this patch go
 * through the wrapping setter.
 */

// eslint-disable-next-line n/no-missing-require -- express internal, present in express 4.x
import Layer from 'express/lib/router/layer';

type AnyFn = ((...args: unknown[]) => unknown) & { __asyncWrapped?: boolean };

const HANDLE = Symbol('asyncErrors.handle');

Object.defineProperty(Layer.prototype, 'handle', {
  enumerable: true,
  get(this: Record<symbol, unknown>) {
    return this[HANDLE];
  },
  set(this: Record<symbol, unknown>, fn: AnyFn) {
    if (typeof fn !== 'function' || fn.__asyncWrapped) {
      this[HANDLE] = fn;
      return;
    }

    const wrapped: AnyFn = function (this: unknown, ...args: unknown[]) {
      // For a normal handler args are (req, res, next); for error
      // middleware they're (err, req, res, next) — `next` is last either way.
      const next = args[args.length - 1];
      const ret = fn.apply(this, args);
      if (
        ret &&
        typeof (ret as Promise<unknown>).catch === 'function' &&
        typeof next === 'function'
      ) {
        (ret as Promise<unknown>).catch(next as (err: unknown) => void);
      }
      return ret;
    };

    // Express inspects fn.length (4 = error middleware) and fn.name (route
    // debugging) — carry both over so the wrapper is behaviorally invisible.
    Object.defineProperty(wrapped, 'length', { value: fn.length });
    Object.defineProperty(wrapped, 'name', { value: fn.name || 'asyncWrappedHandler' });
    wrapped.__asyncWrapped = true;

    this[HANDLE] = wrapped;
  },
});

export {};
