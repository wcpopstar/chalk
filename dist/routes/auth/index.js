"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const router = require('express').Router();
// Split by concern rather than one 590-line file:
//   register.js       — POST /register
//   login.js           — POST /login
//   session.js         — POST /refresh, /logout, /logout-all, GET /me
//   passwordReset.js   — POST /forgot-password, /reset-password
// shared.js holds the rate limiters and helpers used across more than one
// of these (issueSession, token hashing, USER_FIELDS, ...).
router.use(require('./register'));
router.use(require('./login'));
router.use(require('./session'));
router.use(require('./passwordReset'));
module.exports = router;
//# sourceMappingURL=index.js.map