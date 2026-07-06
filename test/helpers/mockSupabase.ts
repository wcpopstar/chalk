export {};
'use strict';

/**
 * A minimal stand-in for @supabase/supabase-js's query builder.
 *
 * The real `supabaseAdmin.from('table').select(...).eq(...).maybeSingle()`
 * chain is a "thenable" — every intermediate call returns an object with
 * `.then()`, so `await`-ing it resolves to `{ data, error }`. This mock
 * reproduces just that shape: every chain method (`select`, `insert`,
 * `update`, `eq`, `or`, `is`, `maybeSingle`, `single`, ...) simply returns
 * itself, and the *order in which queries are awaited* determines which
 * response comes back — controlled by `enqueue()`.
 *
 * This trades strict call-shape assertions (asserting exactly which table
 * or filter was used) for something much more valuable in this codebase:
 * being able to drive route handlers that chain 3-4 Supabase calls in a
 * row through realistic success/failure sequences, in the same order the
 * handler actually issues them. Read each test's `enqueue(...)` calls
 * top-to-bottom — they map 1:1 to the awaited Supabase calls in the route
 * handler being exercised.
 *
 * Usage:
 *   const { supabaseAdmin, enqueue, reset } = createSupabaseMock();
 *   enqueue({ data: null, error: null });         // 1st awaited query
 *   enqueue({ data: { id: 'u1' }, error: null });  // 2nd awaited query
 */
function createSupabaseMock() {
  const queue: any[] = [];

  function enqueue(result: any) {
    queue.push(result);
  }

  function reset() {
    queue.length = 0;
  }

  function makeBuilder() {
    const builder: any = {};

    const chainableMethods = [
      'select', 'insert', 'update', 'delete', 'upsert',
      'eq', 'neq', 'or', 'is', 'in', 'order', 'limit',
      'ilike', 'not', 'lt', 'lte', 'gt', 'gte', 'range',
    ];
    chainableMethods.forEach((method) => {
      builder[method] = () => builder;
    });
    builder.maybeSingle = () => builder;
    builder.single = () => builder;

    // Makes the builder awaitable, like the real supabase-js query builder.
    builder.then = (onFulfilled: any, onRejected: any) => {
      const next = queue.shift() || { data: null, error: null };
      if (next instanceof Error) {
        return Promise.reject(next).then(onFulfilled, onRejected);
      }
      return Promise.resolve(next).then(onFulfilled, onRejected);
    };
    builder.catch = (onRejected: any) => builder.then(undefined, onRejected);

    return builder;
  }

  const supabaseAdmin = {
    from: () => makeBuilder(),
    // supabaseAdmin.rpc(name, params) also returns an awaitable {data, error}
    // builder in the real client (postgrest-js) — it shares the same FIFO
    // queue as .from(...) chains, since callers await both in whatever
    // order the route handler actually issues them.
    rpc: () => makeBuilder(),
    // supabaseAdmin.storage.from(bucket) is a completely separate API
    // surface from the query builder above (used by src/socket/media.ts).
    // .upload() shares the same FIFO queue as everything else (it's
    // awaited, so ordering matters the same way); .getPublicUrl() is
    // synchronous in the real client and doesn't need queue-driven control
    // for these tests, so it just deterministically echoes the path back.
    storage: {
      from: (bucket: any) => ({
        upload: () => makeBuilder(), // enqueue({ error: null }) or ({ error: {...} })
        getPublicUrl: (path: any) => ({ data: { publicUrl: `https://fake.storage.test/${bucket}/${path}` } }),
      }),
    },
  };

  return { supabaseAdmin, enqueue, reset };
}

module.exports = { createSupabaseMock };
