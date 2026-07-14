import { Worker, type ConnectionOptions } from 'bullmq';
import loggerBase from '../utils/logger';
const logger = loggerBase.child({ module: 'email-worker' });
import { queueConnection } from '../queues/connection';
import { EMAIL } from '../queues/queueNames';
import { JOBS } from '../queues/emailQueue';
import { sendPasswordResetEmail, sendCodeEmail } from '../services/mailer';

async function processEmailJob(job: { name: string; data: any }) {
  switch (job.name) {
    case JOBS.PASSWORD_RESET: {
      const { to, resetUrl } = job.data;
      await sendPasswordResetEmail(to, resetUrl);
      return;
    }
    case JOBS.EMAIL_CODE: {
      const { to, code, purpose } = job.data;
      await sendCodeEmail(to, code, purpose);
      return;
    }
    default:
      // Unknown job name — fail loudly rather than silently dropping it,
      // so a typo'd job.name during development shows up immediately.
      throw new Error(`email worker: unknown job name "${job.name}"`);
  }
}

function createEmailWorker() {
  const worker = new Worker(EMAIL, processEmailJob, {
    // Same nested-ioredis version split as in queues/emailQueue.ts — one object
    // at runtime, two structurally distinct Redis types at compile time.
    connection: queueConnection as unknown as ConnectionOptions,
    concurrency: 5,
  });

  worker.on('completed', (job: any) => {
    logger.info({ jobId: job.id, jobName: job.name }, 'Email job completed');
  });
  worker.on('failed', (job: any, err: any) => {
    logger.error({ jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err }, 'Email job failed');
  });
  worker.on('error', (err: any) => {
    logger.error({ err }, 'Email worker error');
  });

  return worker;
}

export { createEmailWorker };
