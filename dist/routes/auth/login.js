"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const usersRepository = require('../../repositories/usersRepository');
const { loginSchema } = require('../../validation/schemas');
const { authLimiter, loginEmailLimiter, issueSession } = require('./shared');
/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in with email and password
 *     description: Returns a fresh access + refresh token pair on success. Rate-limited both by IP and by the email being attempted.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email, example: player@example.com }
 *               password: { type: string, format: password, example: 'Str0ngPass' }
 *     responses:
 *       200:
 *         description: Authenticated
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthResponse' }
 *       400:
 *         description: Validation error (Zod)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       429:
 *         description: Too many attempts
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/login', authLimiter, loginEmailLimiter, async (req, res) => {
    try {
        const parsed = loginSchema.parse(req.body);
        const { email, password } = parsed;
        const { data: user, error } = await usersRepository.findForLogin(email);
        if (error || !user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        await usersRepository.setStatus(user.id, 'online');
        const { password_hash, ...safeUser } = user;
        const { token, refreshToken, expiresIn } = await issueSession(user, req);
        res.json({ user: safeUser, token, refreshToken, expiresIn });
    }
    catch (error) {
        if (error.name === 'ZodError') {
            return res.status(400).json({ error: 'Invalid request payload', details: error.issues.map((e) => e.message) });
        }
        req.log.error({ err: error }, 'Login failed');
        res.status(500).json({ error: 'Could not log in' });
    }
});
module.exports = router;
//# sourceMappingURL=login.js.map