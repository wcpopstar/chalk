export {};
function sendError(res: any, status: any, message: any, details: any) {
  const payload: any = { error: message };
  if (details) payload.details = details;
  return res.status(status).json(payload);
}

module.exports = { sendError };
