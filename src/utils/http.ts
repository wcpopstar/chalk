import type { Response } from 'express';

function sendError(res: Response, status: number, message: string, details?: unknown) {
  const payload: { error: string; details?: unknown } = { error: message };
  if (details) payload.details = details;
  return res.status(status).json(payload);
}

export { sendError };
