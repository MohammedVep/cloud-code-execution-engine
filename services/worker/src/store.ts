import {
  nowIso,
  tenantActiveJobsKey,
  type ExecutionResult,
  redisJobKey
} from "@ccee/common";
import type { Redis } from "ioredis";

const appendAuditEvent = async (
  redis: Redis,
  streamKey: string,
  event: {
    action: string;
    tenantId: string;
    jobId: string;
    metadata?: Record<string, string | number | boolean | null>;
  }
): Promise<void> => {
  await redis.xadd(
    streamKey,
    "*",
    "timestamp",
    nowIso(),
    "actor",
    "worker",
    "action",
    event.action,
    "tenantId",
    event.tenantId,
    "jobId",
    event.jobId,
    "metadata",
    JSON.stringify(event.metadata ?? {})
  );
};

const decrementActiveQuota = async (redis: Redis, tenantId: string): Promise<void> => {
  const script = `
  local activeKey = KEYS[1]
  local active = tonumber(redis.call("GET", activeKey) or "0")
  if active > 0 then
    return redis.call("DECR", activeKey)
  end
  return 0
  `;

  await redis.eval(script, 1, tenantActiveJobsKey(tenantId));
};

export const markRunning = async (
  redis: Redis,
  jobId: string,
  tenantId: string,
  auditStreamKey: string,
  attemptNumber: number
): Promise<void> => {
  const timestamp = nowIso();
  await redis.hset(redisJobKey(jobId), {
    status: "running",
    attemptsMade: String(attemptNumber),
    currentAttempt: String(attemptNumber),
    error: "",
    startedAt: timestamp,
    updatedAt: timestamp
  });

  await appendAuditEvent(redis, auditStreamKey, {
    action: "job_running",
    tenantId,
    jobId,
    metadata: { attemptNumber }
  });
};

export const markRetrying = async (
  redis: Redis,
  jobId: string,
  tenantId: string,
  message: string,
  nextAttemptNumber: number,
  auditStreamKey: string
): Promise<void> => {
  const timestamp = nowIso();
  await redis.hset(redisJobKey(jobId), {
    status: "retrying",
    attemptsMade: String(Math.max(1, nextAttemptNumber - 1)),
    error: message,
    retryScheduledAt: timestamp,
    currentAttempt: String(nextAttemptNumber),
    updatedAt: timestamp
  });

  await appendAuditEvent(redis, auditStreamKey, {
    action: "job_retrying",
    tenantId,
    jobId,
    metadata: { nextAttemptNumber, error: message }
  });
};

export const markDispatched = async (
  redis: Redis,
  jobId: string,
  tenantId: string,
  taskArn: string,
  ttlSeconds: number,
  auditStreamKey: string
): Promise<void> => {
  const timestamp = nowIso();
  await redis.hset(redisJobKey(jobId), {
    status: "dispatched",
    taskArn,
    updatedAt: timestamp
  });
  await redis.expire(redisJobKey(jobId), ttlSeconds);

  await appendAuditEvent(redis, auditStreamKey, {
    action: "job_dispatched",
    tenantId,
    jobId,
    metadata: { taskArn }
  });
};

export const markCompleted = async (
  redis: Redis,
  jobId: string,
  tenantId: string,
  result: ExecutionResult,
  ttlSeconds: number,
  auditStreamKey: string,
  releaseQuota: boolean
): Promise<void> => {
  const timestamp = nowIso();
  await redis.hset(redisJobKey(jobId), {
    status: result.status,
    result: JSON.stringify(result),
    currentAttempt: "",
    retryScheduledAt: "",
    completedAt: timestamp,
    updatedAt: timestamp,
    error: ""
  });
  await redis.expire(redisJobKey(jobId), ttlSeconds);

  if (releaseQuota) {
    await decrementActiveQuota(redis, tenantId);
  }

  await appendAuditEvent(redis, auditStreamKey, {
    action: result.status === "succeeded" ? "job_succeeded" : "job_failed",
    tenantId,
    jobId,
    metadata: {
      timedOut: result.timedOut,
      exitCode: result.exitCode ?? -1,
      durationMs: result.durationMs
    }
  });
};

export const markFailed = async (
  redis: Redis,
  jobId: string,
  tenantId: string,
  message: string,
  ttlSeconds: number,
  auditStreamKey: string,
  releaseQuota: boolean
): Promise<void> => {
  const timestamp = nowIso();
  await redis.hset(redisJobKey(jobId), {
    status: "failed",
    currentAttempt: "",
    retryScheduledAt: "",
    error: message,
    completedAt: timestamp,
    updatedAt: timestamp
  });
  await redis.expire(redisJobKey(jobId), ttlSeconds);

  if (releaseQuota) {
    await decrementActiveQuota(redis, tenantId);
  }

  await appendAuditEvent(redis, auditStreamKey, {
    action: "job_failed",
    tenantId,
    jobId,
    metadata: { error: message }
  });
};
