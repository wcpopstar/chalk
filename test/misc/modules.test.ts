export {};
'use strict';

require('../helpers/testEnv');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

describe('config/swagger.ts', () => {
  it('assembles a valid OpenAPI spec from the route annotations', () => {
    const spec = require('../../src/config/swagger');
    assert.match(spec.openapi, /^3\.0/);
    assert.ok(spec.info && spec.info.title);
    // Sanity: annotations from at least the auth and agora routers made it in.
    const paths = Object.keys(spec.paths || {});
    assert.ok(paths.some((p) => p.startsWith('/api/auth')), `expected auth paths, got: ${paths.slice(0, 5)}`);
    assert.ok(paths.some((p) => p.startsWith('/api/agora')), 'expected agora paths');
  });
});

describe('services/supabase.ts', () => {
  it('exports both clients (anon + service-role)', () => {
    const { supabase, supabaseAdmin } = require('../../src/services/supabase');
    assert.ok(supabase && typeof supabase.from === 'function');
    assert.ok(supabaseAdmin && typeof supabaseAdmin.from === 'function');
  });
});

describe('socket/socketLogger.ts', () => {
  const { socketLogger, attachUserContext } = require('../../src/socket/socketLogger');

  it('attaches a connection id and a child logger to the socket', () => {
    const socket: any = { id: 'sock-1', data: {} };
    let nextCalled = false;

    socketLogger(socket, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.ok(socket.data.connectionId);
    assert.ok(typeof socket.data.log.info === 'function');
  });

  it('attachUserContext enriches the logger with user identity', () => {
    const socket: any = { id: 'sock-1', data: {} };
    socketLogger(socket, () => {});
    const before = socket.data.log;

    attachUserContext(socket, { id: 'u1', username: 'tester' });

    assert.notEqual(socket.data.log, before); // child logger swapped in
    assert.ok(typeof socket.data.log.error === 'function');
  });
});

describe('middleware/metrics.ts', () => {
  const { metricsMiddleware } = require('../../src/middleware/metrics');
  const metrics = require('../../src/utils/metrics');

  function run(req: any, statusCode: number) {
    const res: any = new EventEmitter();
    res.statusCode = statusCode;
    let nextCalled = false;
    metricsMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    res.emit('finish');
  }

  it('records a matched route under its Express template', async () => {
    run({ method: 'GET', route: { path: '/users/:id' }, baseUrl: '/api' }, 200);

    const data = await metrics.httpRequestsTotal.get();
    const matched = data.values.find((v: any) => v.labels.route === '/api/users/:id');
    assert.ok(matched, 'expected a series labeled with the templated route');
  });

  it('buckets unmatched requests under "unmatched" and counts 5xx as errors', async () => {
    run({ method: 'GET', route: null, baseUrl: '' }, 500);

    const reqs = await metrics.httpRequestsTotal.get();
    assert.ok(reqs.values.some((v: any) => v.labels.route === 'unmatched'));

    const errs = await metrics.httpErrorsTotal.get();
    assert.ok(errs.values.some((v: any) => v.labels.route === 'unmatched' && v.labels.status_code === 500));
  });
});
