/**
 * Express 4 ships no types for its internal Layer class, but src/utils/asyncErrors.ts
 * patches it on purpose (see that file's header: it wraps every route handler so an
 * async throw reaches the error middleware instead of becoming an unhandled rejection).
 *
 * Declared here rather than left to an implicit `any` so the patch is checked against
 * the shape it actually relies on — a constructor function with a prototype carrying
 * the `handle` property it swaps out.
 */
declare module 'express/lib/router/layer' {
  interface LayerPrototype {
    handle: unknown;
    [key: string]: unknown;
  }

  interface LayerConstructor {
    new (path: string, options: unknown, fn: unknown): unknown;
    prototype: LayerPrototype;
  }

  const Layer: LayerConstructor;
  export default Layer;
}
