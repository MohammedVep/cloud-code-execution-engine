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
import { SpanStatusCode } from "@opentelemetry/api";
import { endSpan, getTracer, startTelemetry } from "./telemetry.js";

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
const telemetrySdk = startTelemetry(config.telemetry);
const tracer = getTracer();

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
    const scaleSignal =
      queueDepth > 0 ? Math.max(queueDepth, Math.max(1, config.queueDepthMetric.target) + 1) : 0;

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
          },
          {
            MetricName: config.queueDepthMetric.scaleMetricName,
            Dimensions: [
              { Name: "QueueName", Value: config.queueName },
              { Name: "Service", Value: config.queueDepthMetric.serviceName }
            ],
            Unit: "Count",
            Value: scaleSignal
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
    const span = tracer.startSpan("worker.process_job");
    span.setAttribute("ccee.trace_id", payload.traceId ?? "none");
    span.setAttribute("ccee.job_id", payload.jobId);
    span.setAttribute("ccee.tenant_id", payload.tenant.tenantId);
    span.setAttribute("ccee.language", payload.request.language);
    span.setAttribute("ccee.execution_backend", config.executionBackend);
    span.setAttribute("messaging.system", "bullmq");
    span.setAttribute("messaging.destination.name", config.queueName);
    span.setAttribute("messaging.message.id", job.id ?? payload.jobId);
    span.setAttribute("messaging.operation", "process");
    span.setAttribute("ccee.attempt", attemptNumber);

    try {
      await markRunning(
        redis,
        payload.jobId,
        payload.tenant.tenantId,
        config.auditStreamKey,
        attemptNumber,
        payload.traceId
      );

      // Human enhancement point: add new execution backends behind this branch.
      // The worker should only decide dispatch; sandbox policy belongs in the runner/task config.
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
          null,
          config.jobTtlSeconds,
          config.auditStreamKey,
          true,
          payload.traceId
        );
        endSpan(span, result.status === "succeeded" ? SpanStatusCode.OK : SpanStatusCode.ERROR, {
          "ccee.job_status": result.status,
          "ccee.duration_ms": result.durationMs,
          "ccee.exit_code": result.exitCode
        });
        return result;
      }

      const dispatch = await dispatchEcsRunner(ecsClient, config, payload);
      await markDispatched(
        redis,
        payload.jobId,
        payload.tenant.tenantId,
        dispatch,
        config.jobTtlSeconds,
        config.auditStreamKey,
        payload.traceId
      );

      endSpan(span, SpanStatusCode.OK, {
        "ccee.job_status": "dispatched",
        "ccee.task_arn": dispatch.taskArn,
        "ccee.task_definition_arn": dispatch.taskDefinitionArn,
        "ccee.compute_tier": dispatch.computeTier,
        "ccee.purchase_option": dispatch.purchaseOption
      });
      return dispatch;
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      } else {
        span.recordException(String(error));
      }
      endSpan(span, SpanStatusCode.ERROR, {
        "ccee.job_status": "failed",
        "ccee.error": error instanceof Error ? error.message : "Unknown worker failure"
      });
      throw error;
    }
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

  // Human enhancement point: this is the poison-job boundary.
  // Add alerting, quarantine metadata, or automated replay hooks here without losing the original payload.
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
  await telemetrySdk?.shutdown();
  redis.disconnect();
};

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
