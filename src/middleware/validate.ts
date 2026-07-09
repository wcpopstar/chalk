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
import type { Request, Response, NextFunction } from 'express';
import type { ZodType, ZodIssue } from 'zod';

interface ValidateSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

function validate({ body, query, params }: ValidateSchemas = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (body) req.body = body.parse(req.body ?? {});
      if (query) req.query = query.parse(req.query ?? {}) as Request['query'];
      if (params) req.params = params.parse(req.params ?? {}) as Request['params'];
      return next();
    } catch (err: any) {
      if (err.name === 'ZodError') {
        return res.status(400).json({
          error: 'Invalid request',
          details: err.issues.map((issue: ZodIssue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        });
      }
      return next(err);
    }
  };
}

export { validate };
