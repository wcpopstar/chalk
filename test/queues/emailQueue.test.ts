export {};
'use strict';

require('../helpers/testEnv');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule } = require('../helpers/stubModule');

// Swap bullmq for capturing fakes BEFORE anything under test is required —
// these tests exercise OUR queue/worker wiring, not BullMQ itself.
const queueInstances: any[] = [];
const workerInstances: any[] = [];
class FakeQueue {
  name: any; opts: any; added: any[] = []; closed = false; handlers = new Map();
  constructor(name: any, opts: any) { this.name = name; this.opts = opts; queueInstances.push(this); }
  on(event: any, cb: any) { this.handlers.set(event, cb); return this; }
  async add(jobName: any, data: any) { this.added.push({ jobName, data }); }
  async close() { this.closed = true; }
}
class FakeWorker {
  queueName: any; processor: any; opts: any; closed = false; handlers = new Map();
  constructor(queueName: any, processor: any, opts: any) {
    this.queueName = queueName; this.processor = processor; this.opts = opts;
    workerInstances.push(this);
  }
  on(event: any, cb: any) { this.handlers.set(event, cb); return this; }
  async close() { this.closed = true; }
}
stubModule(require.resolve('bullmq'), { Queue: FakeQueue, Worker: FakeWorker });

const emailQueue = require('../../src/queues/emailQueue');
const queuesIndex = require('../../src/queues');
const { createEmailWorker } = require('../../src/workers/emailWorker');
const workers = require('../../src/workers');
const { EMAIL } = require('../../src/queues/queueNames');

describe('queues/emailQueue', () => {
  it('creates the queue lazily, once, with retry/backoff options', async () => {
    assert.equal(queueInstances.length, 0); // nothing at require time

    await emailQueue.enqueuePasswordResetEmail('a@b.c', 'https://app/?reset=t1');

    assert.equal(queueInstances.length, 1);
    const q = queueInstances[0];
    assert.equal(q.name, EMAIL);
    assert.equal(q.opts.defaultJobOptions.attempts, 3);
    assert.deepEqual(q.added, [{ jobName: emailQueue.JOBS.PASSWORD_RESET, data: { to: 'a@b.c', resetUrl: 'https://app/?reset=t1' } }]);

    await emailQueue.enqueuePasswordResetEmail('x@y.z', 'https://app/?reset=t2');
    assert.equal(queueInstances.length, 1); // cached, not re-created
    assert.equal(q.added.length, 2);
  });

  it('closeQueues closes the instantiated queue', async () => {
    await queuesIndex.closeQueues();
    assert.equal(queueInstances[0].closed, true);
  });
});

describe('workers/emailWorker', () => {
  it('createEmailWorker wires the processor to the email queue', () => {
    const worker: any = createEmailWorker();
    assert.equal(worker.queueName, EMAIL);
    assert.equal(worker.opts.concurrency, 5);

    // The logging listeners must not blow up on the shapes BullMQ emits.
    worker.handlers.get('completed')({ id: '1', name: 'password-reset' });
    worker.handlers.get('failed')({ id: '2', name: 'password-reset', attemptsMade: 3 }, new Error('smtp down'));
    worker.handlers.get('failed')(undefined, new Error('job lost'));
    worker.handlers.get('error')(new Error('connection error'));
  });

  it('the processor sends the password-reset email', async () => {
    const worker: any = createEmailWorker();
    // Mailer runs in dev-fallback mode here (no SMTP_HOST in testEnv), so
    // this exercises the real mailer path without a mail server.
    await worker.processor({ name: 'password-reset', data: { to: 'a@b.c', resetUrl: 'https://app/?reset=x' } });
  });

  it('the processor rejects an unknown job name loudly', async () => {
    const worker: any = createEmailWorker();
    await assert.rejects(() => worker.processor({ name: 'push-notification', data: {} }), /unknown job name/);
  });
});

describe('workers/index', () => {
  it('startWorkers is idempotent and closeWorkers closes everything', async () => {
    const beforeCount = workerInstances.length;

    const started = workers.startWorkers();
    assert.equal(workerInstances.length, beforeCount + 1);
    assert.equal(workers.startWorkers(), started); // second call: no new workers
    assert.equal(workerInstances.length, beforeCount + 1);

    await workers.closeWorkers();
    assert.equal(started[0].closed, true);

    // After closing, a restart creates a fresh worker again.
    workers.startWorkers();
    assert.equal(workerInstances.length, beforeCount + 2);
    await workers.closeWorkers();
  });
});
