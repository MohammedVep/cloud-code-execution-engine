import { ECSClient } from "@aws-sdk/client-ecs";
import { queueJobPayloadSchema } from "@ccee/common";
import { Worker } from "bullmq";
import { Redis } from "ioredis";

import { config } from "./config.js";
import { dispatchEcsRunner } from "./runners/ecs-runner.js";
import { executeLocalRunner } from "./runners/local-runner.js";
import { markCompleted, markDispatched, markFailed, markRetrying, markRunning } from "./store.js";

const redisUrl = new URL(config.redisUrl);
const redisConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || "6379"),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  db: redisUrl.pathname && redisUrl.pathname !== "/" ? Number(redisUrl.pathname.slice(1)) : 0,
  maxRetriesPerRequest: null,
  tls: redisUrl.protocol === "rediss:" ? {} : undefined
};

const redis = new Redis(redisConnection);
const ecsClient = new ECSClient({ region: config.awsRegion });

const worker = new Worker(
  config.queueName,
  async (job) => {
    const payload = queueJobPayloadSchema.parse(job.data);
    const attemptNumber = job.attemptsMade + 1;

    await markRunning(redis, payload.jobId, payload.tenant.tenantId, config.auditStreamKey, attemptNumber);

    if (config.executionBackend === "local") {
      const result = await executeLocalRunner(payload, config.runnerImage, config.maxStdioBytes);
      await markCompleted(
        redis,
        payload.jobId,
        payload.tenant.tenantId,
        result,
        config.jobTtlSeconds,
        config.auditStreamKey,
        true
      );
      return result;
    }

    const taskArn = await dispatchEcsRunner(ecsClient, config, payload);
    await markDispatched(
      redis,
      payload.jobId,
      payload.tenant.tenantId,
      taskArn,
      config.jobTtlSeconds,
      config.auditStreamKey
    );

    return { taskArn };
  },
  {
    connection: redisConnection,
    concurrency: config.concurrency
  }
);

worker.on("ready", () => {
  console.log(
    `Worker ready. queue=${config.queueName} backend=${config.executionBackend} attempts=${config.queueJobAttempts} backoffMs=${config.queueRetryBackoffMs}`
  );
});

worker.on("failed", async (job, error) => {
  const parsedPayload = queueJobPayloadSchema.safeParse(job?.data);
  if (!parsedPayload.success) {
    console.error("Worker failed before job ID was available", error);
    return;
  }

  const attemptsMade = job?.attemptsMade ?? 1;
  const maxAttempts = Number(job?.opts.attempts ?? config.queueJobAttempts);
  if (attemptsMade < maxAttempts) {
    await markRetrying(
      redis,
      parsedPayload.data.jobId,
      parsedPayload.data.tenant.tenantId,
      error.message,
      attemptsMade + 1,
      config.auditStreamKey
    );
    console.error(`Job ${parsedPayload.data.jobId} failed attempt ${attemptsMade}/${maxAttempts}`, error);
    return;
  }

  await markFailed(
    redis,
    parsedPayload.data.jobId,
    parsedPayload.data.tenant.tenantId,
    error.message,
    config.jobTtlSeconds,
    config.auditStreamKey,
    true
  );
  console.error(`Job ${parsedPayload.data.jobId} failed`, error);
});

const shutdown = async (): Promise<void> => {
  await worker.close();
  redis.disconnect();
};

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
