export {};
'use strict';

require('../helpers/testEnv');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildTestApp } = require('../helpers/buildTestApp');
const { signAccessToken } = require('../../src/utils/jwt');

const userId = '11111111-1111-4111-8111-111111111111';

// Giphy is reached via global fetch — swap it per test. Saved/restored so
// this file can't leak a fake fetch into other test files (each test file
// runs in its own process, but restoring is still the polite default).
const realFetch = global.fetch;
let fetchImpl: any = null;
(global as any).fetch = (...args: any[]) => fetchImpl(...args);

describe('Gifs routes (/api/gifs)', () => {
  let token: any;

  before(() => {
    ({ token } = signAccessToken({ id: userId, username: 'giffan' }));
  });

  after(() => {
    (global as any).fetch = realFetch;
  });

  beforeEach(() => {
    fetchImpl = () => { throw new Error('fetch not expected in this test'); };
  });

  describe('unconfigured mode (no GIPHY_API_KEY)', () => {
    let app: any;

    before(() => {
      delete process.env.GIPHY_API_KEY;
      delete require.cache[require.resolve('../../src/config/env')];
      delete require.cache[require.resolve('../../src/routes/gifs')];
      app = buildTestApp({ '/api/gifs': require('../../src/routes/gifs') });
    });

    it('rejects requests with no access token', async () => {
      const res = await request(app).get('/api/gifs/search?q=cat');
      assert.equal(res.status, 401);
    });

    it('returns 400 when q is missing', async () => {
      const res = await request(app)
        .get('/api/gifs/search')
        .set('Authorization', `Bearer ${token}`);
      assert.equal(res.status, 400);
    });

    it('returns 503 when GIPHY_API_KEY is not configured', async () => {
      const res = await request(app)
        .get('/api/gifs/search?q=cat')
        .set('Authorization', `Bearer ${token}`);
      assert.equal(res.status, 503);
    });
  });

  describe('configured mode (GIPHY_API_KEY set)', () => {
    let app: any;

    before(() => {
      process.env.GIPHY_API_KEY = 'test-giphy-key';
      delete require.cache[require.resolve('../../src/config/env')];
      delete require.cache[require.resolve('../../src/routes/gifs')];
      app = buildTestApp({ '/api/gifs': require('../../src/routes/gifs') });
    });

    after(() => {
      delete process.env.GIPHY_API_KEY;
    });

    it('proxies Giphy and reduces the response to { id, thumb, full }', async () => {
      let requestedUrl = '';
      fetchImpl = async (url: any) => {
        requestedUrl = String(url);
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                id: 'g1',
                images: {
                  fixed_width_small: { url: 'https://gif/thumb1.gif' },
                  downsized: { url: 'https://gif/full1.gif' },
                },
              },
              // No usable thumb at all -> filtered out of the results.
              { id: 'g2', images: {} },
              // Falls back to preview_gif for thumb and fixed_width for full.
              {
                id: 'g3',
                images: {
                  preview_gif: { url: 'https://gif/thumb3.gif' },
                  fixed_width: { url: 'https://gif/full3.gif' },
                },
              },
            ],
          }),
        };
      };

      const res = await request(app)
        .get('/api/gifs/search?q=cat gif&limit=5')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.results, [
        { id: 'g1', thumb: 'https://gif/thumb1.gif', full: 'https://gif/full1.gif' },
        { id: 'g3', thumb: 'https://gif/thumb3.gif', full: 'https://gif/full3.gif' },
      ]);
      // The key stays server-side and the query is URL-encoded.
      assert.match(requestedUrl, /api_key=test-giphy-key/);
      assert.match(requestedUrl, /q=cat%20gif/);
    });

    it('returns 502 when the Giphy request throws', async () => {
      fetchImpl = async () => { throw new Error('network down'); };

      const res = await request(app)
        .get('/api/gifs/search?q=cat')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 502);
    });

    it('returns 502 when Giphy answers non-OK', async () => {
      fetchImpl = async () => ({ ok: false, status: 429 });

      const res = await request(app)
        .get('/api/gifs/search?q=cat')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 502);
    });

    it('handles a Giphy payload with no data array', async () => {
      fetchImpl = async () => ({ ok: true, json: async () => ({}) });

      const res = await request(app)
        .get('/api/gifs/search?q=cat')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.results, []);
    });
  });

  describe('media proxy (/api/gifs/media)', () => {
    let app: any;

    before(() => {
      delete require.cache[require.resolve('../../src/config/env')];
      delete require.cache[require.resolve('../../src/routes/gifs')];
      app = buildTestApp({ '/api/gifs': require('../../src/routes/gifs') });
    });

    // A tiny valid image response the proxy will accept and stream back.
    function imageResponse(bytes: Buffer, contentType = 'image/gif', finalUrl = 'https://media0.giphy.com/media/x/giphy.gif') {
      const { Readable } = require('stream');
      return {
        ok: true,
        status: 200,
        url: finalUrl,
        headers: {
          get: (h: string) => {
            const k = h.toLowerCase();
            if (k === 'content-type') return contentType;
            if (k === 'content-length') return String(bytes.length);
            return null;
          },
        },
        body: Readable.toWeb(Readable.from(bytes)),
      };
    }

    it('is reachable WITHOUT an access token (fetched via <img src>)', async () => {
      const png = Buffer.from('GIF89a fake bytes');
      fetchImpl = async () => imageResponse(png);

      const res = await request(app)
        .get(`/api/gifs/media?url=${encodeURIComponent('https://media2.giphy.com/media/abc/giphy.gif')}`);

      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'image/gif');
      assert.match(res.headers['cache-control'], /immutable/);
    });

    it('rejects a non-Giphy host (no SSRF / open proxy)', async () => {
      fetchImpl = async () => { throw new Error('fetch should not be called'); };

      const res = await request(app)
        .get(`/api/gifs/media?url=${encodeURIComponent('https://evil.example.com/x.gif')}`);

      assert.equal(res.status, 400);
    });

    it('rejects a non-https Giphy URL', async () => {
      const res = await request(app)
        .get(`/api/gifs/media?url=${encodeURIComponent('http://media2.giphy.com/media/abc/giphy.gif')}`);

      // validate() requires https:// -> 400 before the handler even runs.
      assert.equal(res.status, 400);
    });

    it('returns 502 when the upstream is not an image', async () => {
      fetchImpl = async () => ({
        ok: true,
        status: 200,
        url: 'https://media2.giphy.com/media/abc/giphy.gif',
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) },
        body: null,
      });

      const res = await request(app)
        .get(`/api/gifs/media?url=${encodeURIComponent('https://media2.giphy.com/media/abc/giphy.gif')}`);

      assert.equal(res.status, 502);
    });

    it('returns 502 when a followed redirect leaves the Giphy hosts', async () => {
      const png = Buffer.from('GIF89a');
      fetchImpl = async () => imageResponse(png, 'image/gif', 'https://evil.example.com/x.gif');

      const res = await request(app)
        .get(`/api/gifs/media?url=${encodeURIComponent('https://media2.giphy.com/media/abc/giphy.gif')}`);

      assert.equal(res.status, 502);
    });
  });
});
