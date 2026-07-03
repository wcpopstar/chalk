'use strict';

require('./helpers/testEnv');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildTestApp } = require('./helpers/buildTestApp');

describe('GET /health', () => {
  const app = buildTestApp();

  it('responds 200 with status "ok"', async () => {
    const res = await request(app).get('/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('includes a fresh numeric timestamp on every call', async () => {
    const first = await request(app).get('/health');
    const second = await request(app).get('/health');

    assert.equal(typeof first.body.ts, 'number');
    assert.equal(typeof second.body.ts, 'number');
    assert.ok(second.body.ts >= first.body.ts);
  });

  it('is not affected by an unrelated request body/content-type', async () => {
    const res = await request(app).get('/health').set('Content-Type', 'application/json');

    assert.equal(res.status, 200);
  });
});
