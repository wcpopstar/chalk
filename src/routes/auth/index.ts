import { Router } from 'express';
import register from './register';
import login from './login';
import session from './session';
import passwordReset from './passwordReset';
import emailCodes from './emailCodes';
import passkeys from './passkeys';
import security from './security';
const router = Router();

// Split by concern rather than one 590-line file:
//   register.js       — POST /register
//   login.js           — POST /login
//   session.js         — POST /refresh, /logout, /logout-all, GET /me
//   passwordReset.js   — POST /forgot-password, /reset-password
// shared.js holds the rate limiters and helpers used across more than one
// of these (issueSession, token hashing, USER_FIELDS, ...).
router.use(register);
router.use(login);
router.use(session);
router.use(passwordReset);
router.use(emailCodes);
router.use(passkeys);
router.use(security);

export = router;
