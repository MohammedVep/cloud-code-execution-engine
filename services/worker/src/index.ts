import { ECSClient } from "@aws-sdk/client-ecs";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { queueJobPayloadSchema } from "@ccee/common";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { config } from "./config.js";
import { getQueueDepth } from "./queue-metrics.js";
import { dispatchEcsRunner } from "./runners/ecs-runner.js";
import { executeLocalRunner } from "./runners/local-runner.js";
import { markCompleted, markDeadLettered, markDispatched, markFailed, markRetrying, markRunning } from "./store.js";

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
const cloudWatchClient = new CloudWatchClient({ region: config.awsRegion });
const queue = new Queue(config.queueName, { connection: redisConnection });
const deadLetterQueue = new Queue(config.dlqQueueName, { connection: redisConnection });

const jitteredBackoff = (attemptsMade: number, baseDelayMs: number, maxDelayMs: number): number => {
  const exponential = baseDelayMs * 2 ** Math.max(0, attemptsMade - 1);
  const jitter = Math.floor(Math.random() * baseDelayMs);
  return Math.min(maxDelayMs, exponential + jitter);
};

const publishQueueDepthMetric = async (): Promise<void> => {
  if (config.executionBackend !== "ecs") {
    return;
  }

  try {
    const waitingCount = await queue.getWaitingCount();
    const queueDepth = getQueueDepth(waitingCount);

    await cloudWatchClient.send(
      new PutMetricDataCommand({
        Namespace: config.queueDepthMetric.namespace,
        MetricData: [
          {
            MetricName: config.queueDepthMetric.metricName,
            Dimensions: [
              { Name: "QueueName", Value: config.queueName },
              { Name: "Service", Value: config.queueDepthMetric.serviceName }
            ],
            Unit: "Count",
            Value: queueDepth
          }
        ]
      })
    );
  } catch (error) {
    console.error("queue_depth_metric_publish_failed", error);
  }
};

const queueMetricTimer = setInterval(() => {
  void publishQueueDepthMetric();
}, config.queueDepthMetric.publishIntervalMs);

const worker = new Worker(
  config.queueName,
  async (job) => {
    const payload = queueJobPayloadSchema.parse(job.data);
    const attemptNumber = job.attemptsMade + 1;

    await markRunning(
      redis,
      payload.jobId,
      payload.tenant.tenantId,
      config.auditStreamKey,
      attemptNumber,
      payload.traceId
    );

    if (config.executionBackend === "local") {
      const result = await executeLocalRunner(payload, config.runnerImage, config.maxStdioBytes);
      await markCompleted(
        redis,
        payload.jobId,
        payload.tenant.tenantId,
        result,
        {
          cpuMillicores: payload.request.cpuMillicores,
          memoryMb: payload.request.memoryMb
        },
        config.jobTtlSeconds,
        config.auditStreamKey,
        true,
        payload.traceId
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
      config.auditStreamKey,
      payload.traceId
    );

    return { taskArn };
  },
  {
    connection: redisConnection,
    concurrency: config.concurrency,
    settings: {
      backoffStrategy: (attemptsMade: number) =>
        jitteredBackoff(attemptsMade, config.queueRetryBackoffMs, config.queueRetryMaxDelayMs)
    }
  }
);

worker.on("ready", () => {
  console.log(
    `Worker ready. queue=${config.queueName} backend=${config.executionBackend} attempts=${config.queueJobAttempts} backoffMs=${config.queueRetryBackoffMs}`
  );
  void publishQueueDepthMetric();
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
      config.auditStreamKey,
      parsedPayload.data.traceId
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
    true,
    parsedPayload.data.traceId
  );
  const dlqJobId = `${parsedPayload.data.jobId}-dlq-${Date.now()}`;
  await deadLetterQueue.add(
    dlqJobId,
    {
      ...parsedPayload.data,
      dlq: {
        jobId: parsedPayload.data.jobId,
        error: error.message,
        attemptsMade,
        failedAt: new Date().toISOString()
      }
    },
    {
      jobId: dlqJobId
    }
  );
  await markDeadLettered(
    redis,
    parsedPayload.data.jobId,
    parsedPayload.data.tenant.tenantId,
    dlqJobId,
    error.message,
    config.auditStreamKey,
    parsedPayload.data.traceId
  );
  console.error(`Job ${parsedPayload.data.jobId} failed`, error);
});

const shutdown = async (): Promise<void> => {
  clearInterval(queueMetricTimer);
  await worker.close();
  await queue.close();
  await deadLetterQueue.close();
  redis.disconnect();
};

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
