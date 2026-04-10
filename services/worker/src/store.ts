import {
  classifyFailureCategory,
  estimateExecutionCostUsd,
  nowIso,
  resolveCostModelVersion,
  tenantDailyCostKey,
  tenantActiveJobsKey,
  type ExecutionResult,
  redisJobKey,
  type RunnerComputeTier,
  type RunnerPurchaseOption
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

const incrementDailyCost = async (
  redis: Redis,
  tenantId: string,
  timestampIso: string,
  amountUsd: number,
  ttlSeconds: number
): Promise<void> => {
  const dateKey = timestampIso.slice(0, 10);
  const key = tenantDailyCostKey(tenantId, dateKey);
  await redis.incrbyfloat(key, amountUsd);
  await redis.expire(key, ttlSeconds);
};

export const markRunning = async (
  redis: Redis,
  jobId: string,
  tenantId: string,
  auditStreamKey: string,
  attemptNumber: number,
  traceId?: string
): Promise<void> => {
  const timestamp = nowIso();
  const updates: Record<string, string> = {
    status: "running",
    attemptsMade: String(attemptNumber),
    currentAttempt: String(attemptNumber),
    error: "",
    startedAt: timestamp,
    updatedAt: timestamp
  };
  if (traceId) {
    updates.traceId = traceId;
  }
  await redis.hset(redisJobKey(jobId), updates);

  await appendAuditEvent(redis, auditStreamKey, {
    action: "job_running",
    tenantId,
    jobId,
    metadata: { attemptNumber, traceId: traceId ?? null }
  });
};

export const markRetrying = async (
  redis: Redis,
  jobId: string,
  tenantId: string,
  message: string,
  nextAttemptNumber: number,
  auditStreamKey: string,
  traceId?: string
): Promise<void> => {
  const timestamp = nowIso();
  const updates: Record<string, string> = {
    status: "retrying",
    attemptsMade: String(Math.max(1, nextAttemptNumber - 1)),
    error: message,
    retryScheduledAt: timestamp,
    currentAttempt: String(nextAttemptNumber),
    updatedAt: timestamp
  };
  if (traceId) {
    updates.traceId = traceId;
  }
  await redis.hset(redisJobKey(jobId), updates);

  await appendAuditEvent(redis, auditStreamKey, {
    action: "job_retrying",
    tenantId,
    jobId,
    metadata: { nextAttemptNumber, error: message, traceId: traceId ?? null }
  });
};

export const markDispatched = async (
  redis: Redis,
  jobId: string,
  tenantId: string,
  dispatch: {
    taskArn: string;
    taskDefinitionArn?: string;
    computeTier?: RunnerComputeTier;
    purchaseOption?: RunnerPurchaseOption;
  },
  ttlSeconds: number,
  auditStreamKey: string,
  traceId?: string
): Promise<void> => {
  const timestamp = nowIso();
  const updates: Record<string, string> = {
    status: "dispatched",
    taskArn: dispatch.taskArn,
    updatedAt: timestamp
  };
  if (dispatch.taskDefinitionArn) {
    updates.taskDefinitionArn = dispatch.taskDefinitionArn;
  }
  if (dispatch.computeTier) {
    updates.computeTier = dispatch.computeTier;
  }
  if (dispatch.purchaseOption) {
    updates.purchaseOption = dispatch.purchaseOption;
  }
  if (traceId) {
    updates.traceId = traceId;
  }
  await redis.hset(redisJobKey(jobId), updates);
  await redis.expire(redisJobKey(jobId), ttlSeconds);

  await appendAuditEvent(redis, auditStreamKey, {
    action: "job_dispatched",
    tenantId,
    jobId,
    metadata: {
      taskArn: dispatch.taskArn,
      taskDefinitionArn: dispatch.taskDefinitionArn ?? null,
      computeTier: dispatch.computeTier ?? null,
      purchaseOption: dispatch.purchaseOption ?? null,
      traceId: traceId ?? null
    }
  });
};

export const markCompleted = async (
  redis: Redis,
  jobId: string,
  tenantId: string,
  result: ExecutionResult,
  request: {
    cpuMillicores: number;
    memoryMb: number;
  },
  billing: {
    computeTier?: RunnerComputeTier | null;
    purchaseOption?: RunnerPurchaseOption | null;
  } | null,
  ttlSeconds: number,
  auditStreamKey: string,
  releaseQuota: boolean,
  traceId?: string
): Promise<void> => {
  const timestamp = nowIso();
  const estimatedCostUsd = estimateExecutionCostUsd({
    durationMs: result.durationMs,
    cpuMillicores: request.cpuMillicores,
    memoryMb: request.memoryMb,
    computeTier: billing?.computeTier,
    purchaseOption: billing?.purchaseOption
  });
  const failureCategory = classifyFailureCategory({ result });
  const costModelVersion = resolveCostModelVersion(billing ?? {});

  const updates: Record<string, string> = {
    status: result.status,
    result: JSON.stringify(result),
    estimatedCostUsd: estimatedCostUsd.toFixed(8),
    billableDurationMs: String(result.durationMs),
    failureCategory,
    costModelVersion,
    currentAttempt: "",
    retryScheduledAt: "",
    completedAt: timestamp,
    updatedAt: timestamp,
    error: ""
  };
  if (billing?.computeTier) {
    updates.computeTier = billing.computeTier;
  }
  if (billing?.purchaseOption) {
    updates.purchaseOption = billing.purchaseOption;
  }
  if (traceId) {
    updates.traceId = traceId;
  }
  await redis.hset(redisJobKey(jobId), updates);
  await redis.expire(redisJobKey(jobId), ttlSeconds);
  await incrementDailyCost(redis, tenantId, timestamp, estimatedCostUsd, ttlSeconds);

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
      durationMs: result.durationMs,
      estimatedCostUsd,
      failureCategory,
      computeTier: billing?.computeTier ?? null,
      purchaseOption: billing?.purchaseOption ?? null,
      traceId: traceId ?? null
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
  releaseQuota: boolean,
  traceId?: string
): Promise<void> => {
  const timestamp = nowIso();
  const updates: Record<string, string> = {
    status: "failed",
    estimatedCostUsd: "0.00000000",
    billableDurationMs: "0",
    failureCategory: classifyFailureCategory({ errorMessage: message }),
    costModelVersion: "fargate-v1",
    currentAttempt: "",
    retryScheduledAt: "",
    error: message,
    completedAt: timestamp,
    updatedAt: timestamp
  };
  if (traceId) {
    updates.traceId = traceId;
  }
  await redis.hset(redisJobKey(jobId), updates);
  await redis.expire(redisJobKey(jobId), ttlSeconds);

  if (releaseQuota) {
    await decrementActiveQuota(redis, tenantId);
  }

  await appendAuditEvent(redis, auditStreamKey, {
    action: "job_failed",
    tenantId,
    jobId,
    metadata: { error: message, traceId: traceId ?? null }
  });
};

export const markDeadLettered = async (
  redis: Redis,
  jobId: string,
  tenantId: string,
  dlqJobId: string,
  reason: string,
  auditStreamKey: string,
  traceId?: string
): Promise<void> => {
  const timestamp = nowIso();
  await redis.hset(redisJobKey(jobId), {
    deadLetteredAt: timestamp,
    updatedAt: timestamp
  });

  await appendAuditEvent(redis, auditStreamKey, {
    action: "job_dead_lettered",
    tenantId,
    jobId,
    metadata: { dlqJobId, reason, traceId: traceId ?? null }
  });
};
