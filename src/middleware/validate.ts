/**
 * validate({ body, query, params }) — runs each given Zod schema against
 * the matching part of the request, replaces it with the *parsed* result
 * (so coercion/defaults from the schema — e.g. `limit` turning from the
 * string "20" into the number 20 — are what the route handler actually
 * sees), and responds 400 on the first failure instead of letting bad
 * input reach a repository/DB call.
 *
 * Every route that takes a body, query string, or route param should have
 * a schema here — including GET requests with only query params, and
 * routes whose only input is a route param like `/:id`.
 */
function validate({ body, query, params }: any = {}) {
  return (req: any, res: any, next: any) => {
    try {
      if (body) req.body = body.parse(req.body ?? {});
      if (query) req.query = query.parse(req.query ?? {});
      if (params) req.params = params.parse(req.params ?? {});
      next();
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return res.status(400).json({
          error: 'Invalid request',
          details: err.issues.map((issue: any) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        });
      }
      next(err);
    }
  };
}

export { validate };
