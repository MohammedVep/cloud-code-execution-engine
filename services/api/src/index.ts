import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SUPPORTED_LANGUAGES,
  executionResultSchema,
  nowIso,
  jobRequestSchema,
  queueJobPayloadSchema,
  redisJobKey,
  tenantActiveJobsKey,
  tenantDailyJobsKey,
  tenantJobHistoryKey
} from "@ccee/common";
import fastifyStatic from "@fastify/static";
import { Queue } from "bullmq";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { z } from "zod";

import { generateExecutionAnalysis } from "./analysis.js";
import { appendAuditEvent } from "./audit.js";
import { config } from "./config.js";
import { reserveQuota, rollbackReservedQuota } from "./quota.js";
import { loadTenantApiKeys, type TenantPrincipal } from "./tenants.js";

const app = Fastify({ logger: true });
const tenantRegistry = loadTenantApiKeys(config.TENANT_API_KEYS_JSON);

if (tenantRegistry.size === 0) {
  throw new Error("TENANT_API_KEYS_JSON configured no tenants");
}

const redisUrl = new URL(config.REDIS_URL);
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
const queue = new Queue(config.JOB_QUEUE_NAME, { connection: redisConnection });
const publicRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

void app.register(fastifyStatic, {
  root: publicRoot
});

const listJobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(config.JOB_LIST_MAX_LIMIT).optional()
});

const listAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const parseJson = <T>(value: string | undefined): T | null => {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const parseExecutionResult = (value: string | undefined) => {
  const decoded = parseJson<unknown>(value);
  if (!decoded) {
    return null;
  }

  const parsed = executionResultSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
};

const historyTrimScript = `
local historyKey = KEYS[1]
local maxItems = tonumber(ARGV[1])
local size = tonumber(redis.call("ZCARD", historyKey))
if size > maxItems then
  redis.call("ZREMRANGEBYRANK", historyKey, 0, size - maxItems - 1)
end
return 1
`;

const appendHistoryItem = async (tenantId: string, jobId: string): Promise<void> => {
  const historyKey = tenantJobHistoryKey(tenantId);

  await redis.zadd(historyKey, Date.now(), jobId);
  await redis.eval(historyTrimScript, 1, historyKey, String(config.JOB_HISTORY_MAX));
  await redis.expire(historyKey, config.JOB_TTL_SECONDS);
};

const streamFieldsToObject = (fields: string[]): Record<string, string> => {
  const data: Record<string, string> = {};

  for (let index = 0; index < fields.length; index += 2) {
    const key = fields[index];
    const value = fields[index + 1];
    if (key) {
      data[key] = value ?? "";
    }
  }

  return data;
};

const toInt = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeLanguage = (value: string | undefined): (typeof SUPPORTED_LANGUAGES)[number] => {
  if (value && SUPPORTED_LANGUAGES.includes(value as (typeof SUPPORTED_LANGUAGES)[number])) {
    return value as (typeof SUPPORTED_LANGUAGES)[number];
  }

  return "javascript";
};

const serializeJob = (data: Record<string, string>) => ({
  jobId: data.jobId,
  tenantId: data.tenantId,
  status: data.status,
  language: data.language,
  createdAt: data.createdAt,
  startedAt: data.startedAt || null,
  completedAt: data.completedAt || null,
  request: {
    timeoutMs: toInt(data.timeoutMs, 3_000),
    memoryMb: toInt(data.memoryMb, 128),
    cpuMillicores: toInt(data.cpuMillicores, 256)
  },
  attempts: {
    max: data.maxAttempts ? toInt(data.maxAttempts, 1) : null,
    made: data.attemptsMade ? toInt(data.attemptsMade, 0) : 0,
    current: data.currentAttempt ? toInt(data.currentAttempt, 1) : null
  },
  result: parseExecutionResult(data.result),
  analysis: parseJson(data.analysis),
  error: data.error || null,
  updatedAt: data.updatedAt
});

const getApiKey = (request: FastifyRequest): string | null => {
  const raw = request.headers["x-api-key"];
  if (!raw) {
    return null;
  }

  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }

  return raw;
};

const authenticateTenant = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<TenantPrincipal | null> => {
  const apiKey = getApiKey(request);
  if (!apiKey) {
    await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
      actor: "api",
      action: "auth_failed",
      metadata: { reason: "missing_api_key" }
    });

    await reply.code(401).send({ error: "unauthorized" });
    return null;
  }

  const tenant = tenantRegistry.get(apiKey);
  if (!tenant) {
    await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
      actor: "api",
      action: "auth_failed",
      metadata: { reason: "invalid_api_key" }
    });

    await reply.code(401).send({ error: "unauthorized" });
    return null;
  }

  return tenant;
};

app.get("/health", async () => ({ status: "ok", service: "api" }));

app.get("/", async (_request, reply) => reply.sendFile("index.html"));

app.get("/v1/quotas", async (request, reply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const dateKey = new Date().toISOString().slice(0, 10);
  const [active, daily] = await redis.mget(
    tenantActiveJobsKey(tenant.tenantId),
    tenantDailyJobsKey(tenant.tenantId, dateKey)
  );

  return reply.send({
    tenantId: tenant.tenantId,
    limits: {
      maxConcurrentJobs: tenant.maxConcurrentJobs,
      maxDailyJobs: tenant.maxDailyJobs
    },
    usage: {
      activeJobs: Number(active || 0),
      dailyJobs: Number(daily || 0),
      dailyDate: dateKey
    }
  });
});

app.post("/v1/jobs", async (request, reply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const parsed = jobRequestSchema.safeParse(request.body ?? {});

  if (!parsed.success) {
    return reply.code(400).send({
      error: "validation_error",
      issues: parsed.error.flatten()
    });
  }

  const reservation = await reserveQuota(redis, tenant, config.DAILY_QUOTA_TTL_SECONDS);
  if (!reservation.allowed) {
    await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
      actor: "api",
      action: "quota_rejected",
      tenantId: tenant.tenantId,
      metadata: {
        reason: reservation.reason,
        activeJobs: reservation.activeJobs,
        dailyJobs: reservation.dailyJobs
      }
    });

    return reply.code(429).send({
      error: "quota_exceeded",
      reason: reservation.reason,
      limits: {
        maxConcurrentJobs: tenant.maxConcurrentJobs,
        maxDailyJobs: tenant.maxDailyJobs
      },
      usage: {
        activeJobs: reservation.activeJobs,
        dailyJobs: reservation.dailyJobs
      }
    });
  }

  const jobId = randomUUID();
  const createdAt = nowIso();
  const payload = queueJobPayloadSchema.parse({
    jobId,
    tenant: {
      tenantId: tenant.tenantId,
      apiKeyFingerprint: tenant.apiKeyFingerprint
    },
    request: parsed.data,
    createdAt
  });

  const key = redisJobKey(jobId);
  await redis.hset(key, {
    jobId,
    tenantId: payload.tenant.tenantId,
    status: "queued",
    language: payload.request.language,
    sourceCode: payload.request.sourceCode,
    stdin: payload.request.stdin,
    timeoutMs: String(payload.request.timeoutMs),
    memoryMb: String(payload.request.memoryMb),
    cpuMillicores: String(payload.request.cpuMillicores),
    maxAttempts: String(config.QUEUE_JOB_ATTEMPTS),
    attemptsMade: "0",
    currentAttempt: "1",
    createdAt,
    updatedAt: createdAt
  });
  await redis.expire(key, config.JOB_TTL_SECONDS);
  await appendHistoryItem(payload.tenant.tenantId, jobId);

  try {
    await queue.add(jobId, payload, {
      jobId,
      attempts: config.QUEUE_JOB_ATTEMPTS,
      backoff: {
        type: "exponential",
        delay: config.QUEUE_RETRY_BACKOFF_MS
      },
      removeOnComplete: {
        age: config.JOB_TTL_SECONDS
      },
      removeOnFail: {
        age: config.JOB_TTL_SECONDS
      }
    });
  } catch (error) {
    await rollbackReservedQuota(redis, tenant.tenantId, reservation.dateKey);
    await redis.del(key);
    await redis.zrem(tenantJobHistoryKey(tenant.tenantId), jobId);

    await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
      actor: "api",
      action: "job_enqueue_failed",
      tenantId: tenant.tenantId,
      jobId,
      metadata: {
        error: error instanceof Error ? error.message : "unknown"
      }
    });

    request.log.error({ error }, "Queue enqueue failed");
    return reply.code(503).send({ error: "queue_unavailable" });
  }

  await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
    actor: "api",
    action: "job_submitted",
    tenantId: tenant.tenantId,
    jobId,
    metadata: {
      language: payload.request.language,
      timeoutMs: payload.request.timeoutMs,
      memoryMb: payload.request.memoryMb,
      cpuMillicores: payload.request.cpuMillicores,
      maxAttempts: config.QUEUE_JOB_ATTEMPTS
    }
  });

  return reply.code(202).send({
    jobId,
    status: "queued",
    statusUrl: `/v1/jobs/${jobId}`
  });
});

app.get("/v1/jobs", async (request, reply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const parsedQuery = listJobsQuerySchema.safeParse(request.query ?? {});
  if (!parsedQuery.success) {
    return reply.code(400).send({ error: "validation_error", issues: parsedQuery.error.flatten() });
  }

  const limit = parsedQuery.data.limit ?? config.JOB_LIST_DEFAULT_LIMIT;
  const jobIds = await redis.zrevrange(tenantJobHistoryKey(tenant.tenantId), 0, limit - 1);

  if (jobIds.length === 0) {
    return reply.send({ tenantId: tenant.tenantId, items: [] });
  }

  const pipeline = redis.multi();
  for (const jobId of jobIds) {
    pipeline.hgetall(redisJobKey(jobId));
  }

  const rows = (await pipeline.exec()) ?? [];

  const items = rows
    .map((row) => row?.[1] as Record<string, string>)
    .filter((data) => data?.status && data.tenantId === tenant.tenantId)
    .map(serializeJob);

  return reply.send({ tenantId: tenant.tenantId, items });
});

app.get<{ Params: { jobId: string } }>("/v1/jobs/:jobId", async (request, reply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const key = redisJobKey(request.params.jobId);
  const data = await redis.hgetall(key);

  if (!data.status || data.tenantId !== tenant.tenantId) {
    return reply.code(404).send({ error: "not_found" });
  }

  return reply.send(serializeJob(data));
});

app.post<{ Params: { jobId: string } }>("/v1/jobs/:jobId/analyze", async (request, reply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const key = redisJobKey(request.params.jobId);
  const data = await redis.hgetall(key);

  if (!data.status || data.tenantId !== tenant.tenantId) {
    return reply.code(404).send({ error: "not_found" });
  }

  const sourceCode = (data.sourceCode || "").slice(0, config.ANALYSIS_MAX_SOURCE_CHARS);
  const analysis = generateExecutionAnalysis({
    status: data.status,
    request: {
      language: normalizeLanguage(data.language),
      sourceCode,
      timeoutMs: toInt(data.timeoutMs, 3_000),
      memoryMb: toInt(data.memoryMb, 128),
      cpuMillicores: toInt(data.cpuMillicores, 256)
    },
    result: parseExecutionResult(data.result),
    error: data.error || null
  });

  await redis.hset(key, {
    analysis: JSON.stringify(analysis),
    analysisUpdatedAt: analysis.generatedAt,
    updatedAt: nowIso()
  });

  await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
    actor: "api",
    action: "job_analyzed",
    tenantId: tenant.tenantId,
    jobId: request.params.jobId,
    metadata: {
      confidence: analysis.confidence,
      summary: analysis.summary.slice(0, 120)
    }
  });

  return reply.send({
    jobId: request.params.jobId,
    status: data.status,
    analysis
  });
});

app.get("/v1/audit", async (request, reply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const parsedQuery = listAuditQuerySchema.safeParse(request.query ?? {});
  if (!parsedQuery.success) {
    return reply.code(400).send({ error: "validation_error", issues: parsedQuery.error.flatten() });
  }

  const limit = parsedQuery.data.limit ?? 20;
  const scanCount = Math.min(limit * 10, 1_000);
  const entries = await redis.xrevrange(config.AUDIT_STREAM_KEY, "+", "-", "COUNT", scanCount);

  const events = entries
    .map((entry) => {
      const [streamId, fields] = entry;
      const fieldMap = streamFieldsToObject(fields);
      return {
        streamId,
        timestamp: fieldMap.timestamp,
        actor: fieldMap.actor,
        action: fieldMap.action,
        tenantId: fieldMap.tenantId,
        jobId: fieldMap.jobId || null,
        metadata: parseJson<Record<string, unknown>>(fieldMap.metadata) ?? {}
      };
    })
    .filter((event) => event.tenantId === tenant.tenantId)
    .slice(0, limit);

  return reply.send({ tenantId: tenant.tenantId, events });
});

const start = async (): Promise<void> => {
  try {
    await app.listen({ host: "0.0.0.0", port: config.API_PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

const shutdown = async (): Promise<void> => {
  await queue.close();
  redis.disconnect();
  await app.close();
};

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

void start();
