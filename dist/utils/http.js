"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function sendError(res, status, message, details) {
    const payload = { error: message };
    if (details)
        payload.details = details;
    return res.status(status).json(payload);
}
module.exports = { sendError };
//# sourceMappingURL=http.js.map