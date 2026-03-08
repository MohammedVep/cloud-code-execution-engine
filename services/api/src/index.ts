import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeServicesCommand, ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import {
  SUPPORTED_LANGUAGES,
  classifyFailureCategory,
  executionResultSchema,
  nowIso,
  jobRequestSchema,
  queueJobPayloadSchema,
  redisJobKey,
  tenantActiveJobsKey,
  tenantDailyCostKey,
  tenantDailyJobsKey,
  tenantJobHistoryKey,
  tenantRateLimitKey,
  tenantSubmitRateLimitKey
} from "@ccee/common";
import fastifyStatic from "@fastify/static";
import { Queue } from "bullmq";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

import { generateExecutionAnalysis } from "./analysis.js";
import { appendAuditEvent } from "./audit.js";
import { config } from "./config.js";
import { reserveQuota, rollbackReservedQuota } from "./quota.js";
import { evaluatePayloadSizeLimits } from "./request-guards.js";
import {
  loadTenantApiKeys,
  loadTenantPolicies,
  type TenantPolicy,
  type TenantPrincipal
} from "./tenants.js";

declare module "fastify" {
  interface FastifyRequest {
    traceId: string;
    startedAtMs: number;
    authTenantId?: string;
    authSubject?: string;
  }
}

type AuthenticatedTenant = TenantPrincipal & {
  authType: "api_key" | "jwt";
  subject: string;
};

type PrincipalResolution =
  | {
      ok: true;
      tenant: AuthenticatedTenant;
    }
  | {
      ok: false;
      reason: string;
      statusCode: 401 | 403;
    };

type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  retryAfterSeconds: number;
  resetEpochSeconds: number;
  windowSeconds: number;
};

const app = Fastify({ logger: true });
const tenantRegistry = loadTenantApiKeys(config.TENANT_API_KEYS_JSON);
const configuredTenantPolicies = loadTenantPolicies(config.TENANT_POLICIES_JSON);

if (config.AUTH_MODE === "api_key" && tenantRegistry.size === 0) {
  throw new Error("TENANT_API_KEYS_JSON configured no tenants while AUTH_MODE=api_key");
}

const tenantPolicyRegistry = new Map<string, TenantPolicy>();
for (const tenant of tenantRegistry.values()) {
  if (!tenantPolicyRegistry.has(tenant.tenantId)) {
    tenantPolicyRegistry.set(tenant.tenantId, {
      tenantId: tenant.tenantId,
      maxConcurrentJobs: tenant.maxConcurrentJobs,
      maxDailyJobs: tenant.maxDailyJobs
    });
  }
}

for (const [tenantId, policy] of configuredTenantPolicies.entries()) {
  tenantPolicyRegistry.set(tenantId, policy);
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
const dlqQueue = new Queue(config.DLQ_QUEUE_NAME, { connection: redisConnection });
const cloudWatchClient = new CloudWatchClient({ region: config.AWS_REGION });
const ecsClient = new ECSClient({ region: config.AWS_REGION });
const publicRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const jwtJwks = config.JWT_JWKS_URL ? createRemoteJWKSet(new URL(config.JWT_JWKS_URL)) : null;

const parseAdminKeys = (value: string): Set<string> => {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return new Set(parsed.map((item) => String(item)).filter((item) => item.length > 0));
    }
  } catch (error) {
    app.log.error({ err: error }, "admin_api_keys_parse_failed");
  }
  return new Set<string>();
};

const adminApiKeys = parseAdminKeys(config.ADMIN_API_KEYS_JSON);

void app.register(fastifyStatic, {
  root: publicRoot
});

const listJobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(config.JOB_LIST_MAX_LIMIT).optional()
});

const listAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const listCostsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).optional()
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

const publishQueueDepthMetric = async (): Promise<void> => {
  try {
    const counts = await queue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "paused",
      "prioritized",
      "waiting-children"
    );
    const pending =
      (counts.waiting ?? 0) +
      (counts.active ?? 0) +
      (counts.delayed ?? 0) +
      (counts.paused ?? 0) +
      (counts.prioritized ?? 0) +
      (counts["waiting-children"] ?? 0);

    await cloudWatchClient.send(
      new PutMetricDataCommand({
        Namespace: config.QUEUE_DEPTH_METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: config.QUEUE_DEPTH_METRIC_NAME,
            Dimensions: [
              { Name: "QueueName", Value: config.JOB_QUEUE_NAME },
              { Name: "Service", Value: config.QUEUE_DEPTH_METRIC_SERVICE_NAME }
            ],
            Unit: "Count",
            Value: pending
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
}, config.QUEUE_DEPTH_PUBLISH_INTERVAL_MS);

queueMetricTimer.unref?.();
void publishQueueDepthMetric();

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

const rateLimitScript = `
local key = KEYS[1]
local ttlSeconds = tonumber(ARGV[1])

local count = redis.call("INCR", key)
if count == 1 then
  redis.call("EXPIRE", key, ttlSeconds)
end

local ttl = redis.call("TTL", key)
if ttl < 0 then
  ttl = ttlSeconds
end

return {count, ttl}
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

const toFloat = (value: string | null | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getJobIdParam = (request: FastifyRequest): string | null => {
  const params = request.params as Record<string, unknown>;
  const jobId = params.jobId;
  if (typeof jobId === "string" && jobId.trim().length > 0) {
    return jobId.trim();
  }

  const id = params.id;
  if (typeof id === "string" && id.trim().length > 0) {
    return id.trim();
  }

  return null;
};

const normalizeLanguage = (value: string | undefined): (typeof SUPPORTED_LANGUAGES)[number] => {
  if (value && SUPPORTED_LANGUAGES.includes(value as (typeof SUPPORTED_LANGUAGES)[number])) {
    return value as (typeof SUPPORTED_LANGUAGES)[number];
  }

  return "javascript";
};

const normalizeTraceId = (value: string): string =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9_.:/-]/g, "_")
    .slice(0, 128);

const coerceTraceId = (value: string): string => {
  const normalized = normalizeTraceId(value);
  if (normalized.length >= 8) {
    return normalized;
  }

  return randomUUID();
};

const serializeJob = (data: Record<string, string>) => {
  const result = parseExecutionResult(data.result);
  const error = data.error || null;
  const inferredFailureCategory = data.failureCategory || classifyFailureCategory({ result, errorMessage: error });
  const normalizedStatus = data.status === "failed" && result?.timedOut ? "timed_out" : data.status;

  return {
    jobId: data.jobId,
    tenantId: data.tenantId,
    traceId: data.traceId || null,
    status: normalizedStatus,
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
    result,
    billing: {
      estimatedCostUsd: Number(toFloat(data.estimatedCostUsd, 0).toFixed(8)),
      billableDurationMs: toInt(data.billableDurationMs, result?.durationMs ?? 0),
      costModelVersion: data.costModelVersion || null
    },
    failureCategory: inferredFailureCategory,
    analysis: parseJson(data.analysis),
    analysisProvider: data.analysisProvider || null,
    analysisUpdatedAt: data.analysisUpdatedAt || null,
    analysisFallbackReason: data.analysisFallbackReason || null,
    error,
    updatedAt: data.updatedAt
  };
};

const fingerprintIdentity = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const getHeaderValue = (value: string | string[] | undefined): string | null => {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" && first.trim().length > 0 ? first.trim() : null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const getApiKey = (request: FastifyRequest): string | null => getHeaderValue(request.headers["x-api-key"]);

const getBearerToken = (request: FastifyRequest): string | null => {
  const authorization = getHeaderValue(request.headers.authorization);
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    return null;
  }

  const token = match[1].trim();
  return token.length > 0 ? token : null;
};

const parseIdList = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const requireAdmin = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<{ apiKey: string; tenant: TenantPrincipal } | null> => {
  const apiKey = getApiKey(request);
  if (!apiKey) {
    await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
      actor: "api",
      action: "admin_auth_missing",
      tenantId: "unknown",
      metadata: { path: request.routeOptions.url ?? request.url, traceId: request.traceId }
    });

    reply.code(401).send({ error: "admin_auth_missing", traceId: request.traceId });
    return null;
  }

  if (!adminApiKeys.has(apiKey)) {
    await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
      actor: "api",
      action: "admin_auth_denied",
      tenantId: "unknown",
      metadata: { path: request.routeOptions.url ?? request.url, traceId: request.traceId }
    });

    reply.code(403).send({ error: "admin_forbidden", traceId: request.traceId });
    return null;
  }

  const tenant = tenantRegistry.get(apiKey);
  if (!tenant) {
    reply.code(403).send({ error: "admin_key_not_mapped", traceId: request.traceId });
    return null;
  }

  return { apiKey, tenant };
};

const getTraceId = (request: FastifyRequest): string => {
  const requestedId = getHeaderValue(request.headers["x-request-id"]);
  if (requestedId) {
    return coerceTraceId(requestedId);
  }

  return coerceTraceId(String(request.id));
};

const utcDateKey = (daysAgo: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
};

const readStringClaim = (payload: JWTPayload, claimName: string): string | null => {
  const value = (payload as Record<string, unknown>)[claimName];
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const resolveApiKeyPrincipal = (apiKey: string | null): PrincipalResolution => {
  if (!apiKey) {
    return { ok: false, reason: "missing_api_key", statusCode: 401 };
  }

  const tenant = tenantRegistry.get(apiKey);
  if (!tenant) {
    return { ok: false, reason: "invalid_api_key", statusCode: 401 };
  }

  return {
    ok: true,
    tenant: {
      ...tenant,
      authType: "api_key",
      subject: tenant.apiKeyFingerprint
    }
  };
};

const resolveJwtPrincipal = async (token: string | null): Promise<PrincipalResolution> => {
  if (!token) {
    return { ok: false, reason: "missing_bearer_token", statusCode: 401 };
  }

  if (!jwtJwks) {
    return { ok: false, reason: "jwt_not_configured", statusCode: 401 };
  }

  try {
    const verificationOptions = config.JWT_AUDIENCE
      ? {
          issuer: config.JWT_ISSUER,
          audience: config.JWT_AUDIENCE
        }
      : {
          issuer: config.JWT_ISSUER
        };

    const { payload } = await jwtVerify(token, jwtJwks, verificationOptions);

    const tenantId = readStringClaim(payload, config.JWT_TENANT_CLAIM);
    if (!tenantId) {
      return { ok: false, reason: "missing_jwt_tenant_claim", statusCode: 401 };
    }

    const subject = readStringClaim(payload, config.JWT_SUBJECT_CLAIM);
    if (!subject) {
      return { ok: false, reason: "missing_jwt_subject_claim", statusCode: 401 };
    }

    const tenantPolicy = tenantPolicyRegistry.get(tenantId);
    if (!tenantPolicy) {
      return { ok: false, reason: "unknown_tenant_policy", statusCode: 403 };
    }

    return {
      ok: true,
      tenant: {
        tenantId,
        maxConcurrentJobs: tenantPolicy.maxConcurrentJobs,
        maxDailyJobs: tenantPolicy.maxDailyJobs,
        apiKeyFingerprint: fingerprintIdentity(`jwt:${tenantId}:${subject}`),
        authType: "jwt",
        subject
      }
    };
  } catch {
    return { ok: false, reason: "invalid_jwt", statusCode: 401 };
  }
};

const evaluateRateLimit = async (tenantId: string): Promise<RateLimitDecision> => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowSeconds = config.RATE_LIMIT_WINDOW_SECONDS;
  const bucket = Math.floor(nowSeconds / windowSeconds);
  const rateLimitKey = tenantRateLimitKey(tenantId, String(bucket));

  const result = (await redis.eval(
    rateLimitScript,
    1,
    rateLimitKey,
    String(windowSeconds)
  )) as [number, number];

  const used = Number(result[0] ?? 0);
  const ttl = Math.max(1, Number(result[1] ?? windowSeconds));
  const limit = config.RATE_LIMIT_REQUESTS_PER_MINUTE;
  const remaining = Math.max(0, limit - used);

  return {
    allowed: used <= limit,
    limit,
    used,
    remaining,
    retryAfterSeconds: ttl,
    resetEpochSeconds: nowSeconds + ttl,
    windowSeconds
  };
};

const evaluateSubmitRateLimit = async (tenantId: string): Promise<RateLimitDecision> => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowSeconds = config.RATE_LIMIT_WINDOW_SECONDS;
  const bucket = Math.floor(nowSeconds / windowSeconds);
  const rateLimitKey = tenantSubmitRateLimitKey(tenantId, String(bucket));

  const result = (await redis.eval(
    rateLimitScript,
    1,
    rateLimitKey,
    String(windowSeconds)
  )) as [number, number];

  const used = Number(result[0] ?? 0);
  const ttl = Math.max(1, Number(result[1] ?? windowSeconds));
  const limit = config.SUBMIT_RATE_LIMIT_PER_MINUTE;
  const remaining = Math.max(0, limit - used);

  return {
    allowed: used <= limit,
    limit,
    used,
    remaining,
    retryAfterSeconds: ttl,
    resetEpochSeconds: nowSeconds + ttl,
    windowSeconds
  };
};

const setRateLimitHeaders = (reply: FastifyReply, decision: RateLimitDecision): void => {
  reply.header("x-ratelimit-limit", String(decision.limit));
  reply.header("x-ratelimit-remaining", String(decision.remaining));
  reply.header("x-ratelimit-reset", String(decision.resetEpochSeconds));
};

const authenticateTenant = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthenticatedTenant | null> => {
  const apiKey = getApiKey(request);
  const bearerToken = getBearerToken(request);

  let resolution: PrincipalResolution;

  if (config.AUTH_MODE === "api_key") {
    resolution = resolveApiKeyPrincipal(apiKey);
  } else if (config.AUTH_MODE === "jwt") {
    resolution = await resolveJwtPrincipal(bearerToken);
  } else if (bearerToken) {
    resolution = await resolveJwtPrincipal(bearerToken);
  } else {
    resolution = resolveApiKeyPrincipal(apiKey);
  }

  if (!resolution.ok) {
    await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
      actor: "api",
      action: "auth_failed",
      metadata: {
        reason: resolution.reason,
        path: request.routeOptions.url ?? request.url,
        method: request.method,
        traceId: request.traceId
      }
    });

    await reply.code(resolution.statusCode).send({
      error: resolution.statusCode === 403 ? "forbidden" : "unauthorized",
      reason: resolution.reason,
      traceId: request.traceId
    });
    return null;
  }

  const rateLimit = await evaluateRateLimit(resolution.tenant.tenantId);
  setRateLimitHeaders(reply, rateLimit);

  if (!rateLimit.allowed) {
    await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
      actor: "api",
      action: "rate_limited",
      tenantId: resolution.tenant.tenantId,
      metadata: {
        method: request.method,
        path: request.routeOptions.url ?? request.url,
        limit: rateLimit.limit,
        used: rateLimit.used,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        traceId: request.traceId
      }
    });

    await reply
      .code(429)
      .header("retry-after", String(rateLimit.retryAfterSeconds))
      .send({
        error: "rate_limited",
        traceId: request.traceId,
        limit: rateLimit.limit,
        used: rateLimit.used,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        windowSeconds: rateLimit.windowSeconds
      });
    return null;
  }

  request.authTenantId = resolution.tenant.tenantId;
  request.authSubject = resolution.tenant.subject;
  return resolution.tenant;
};

app.addHook("onRequest", async (request, reply) => {
  request.traceId = getTraceId(request);
  request.startedAtMs = Date.now();
  reply.header("x-request-id", request.traceId);
});

app.addHook("onResponse", async (request, reply) => {
  const durationMs = Math.max(0, Date.now() - (request.startedAtMs || Date.now()));
  request.log.info(
    {
      traceId: request.traceId,
      tenantId: request.authTenantId ?? null,
      subject: request.authSubject ?? null,
      method: request.method,
      path: request.routeOptions.url ?? request.url,
      statusCode: reply.statusCode,
      durationMs
    },
    "request_completed"
  );
});

app.get("/health", async () => ({ status: "ok", service: "api" }));
app.get("/health/summary", async () => {
  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "paused",
    "prioritized",
    "waiting-children",
    "failed",
    "completed"
  );
  const pending =
    (counts.waiting ?? 0) +
    (counts.active ?? 0) +
    (counts.delayed ?? 0) +
    (counts.paused ?? 0) +
    (counts.prioritized ?? 0) +
    (counts["waiting-children"] ?? 0);

  return {
    status: "ok",
    service: "api",
    queue: {
      pending,
      counts
    },
    autoscaling: {
      queueDepthTarget: config.QUEUE_DEPTH_TARGET
    },
    updatedAt: new Date().toISOString()
  };
});

app.get("/", async (_request, reply) => reply.sendFile("index.html"));
app.get("/admin/observability", async (_request, reply) => reply.sendFile("index.html"));

const adminBurstSchema = z.object({
  count: z.coerce.number().int().min(1).max(config.ADMIN_BURST_MAX).default(config.ADMIN_BURST_MAX)
});

app.get("/v1/admin/metrics", async (request, reply) => {
  const admin = await requireAdmin(request, reply);
  if (!admin) {
    return;
  }

  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "paused",
    "prioritized",
    "waiting-children",
    "failed",
    "completed"
  );
  const pending =
    (counts.waiting ?? 0) +
    (counts.active ?? 0) +
    (counts.delayed ?? 0) +
    (counts.paused ?? 0) +
    (counts.prioritized ?? 0) +
    (counts["waiting-children"] ?? 0);

  const dlqCounts = await dlqQueue.getJobCounts("waiting", "active", "delayed", "paused", "failed", "completed");
  const dlqPending =
    (dlqCounts.waiting ?? 0) + (dlqCounts.active ?? 0) + (dlqCounts.delayed ?? 0) + (dlqCounts.paused ?? 0);

  let ecs = null;
  if (config.ECS_CLUSTER_ARN) {
    try {
      const describe = await ecsClient.send(
        new DescribeServicesCommand({
          cluster: config.ECS_CLUSTER_ARN,
          services: [config.ECS_WORKER_SERVICE_NAME, config.ECS_API_SERVICE_NAME]
        })
      );

      const lookup = new Map(
        (describe.services ?? []).map((service) => [service.serviceName ?? "unknown", service])
      );
      const worker = lookup.get(config.ECS_WORKER_SERVICE_NAME);
      const api = lookup.get(config.ECS_API_SERVICE_NAME);

      ecs = {
        clusterArn: config.ECS_CLUSTER_ARN,
        worker: worker
          ? {
              serviceName: worker.serviceName,
              desired: worker.desiredCount ?? 0,
              running: worker.runningCount ?? 0,
              pending: worker.pendingCount ?? 0,
              taskDefinition: worker.taskDefinition
            }
          : null,
        api: api
          ? {
              serviceName: api.serviceName,
              desired: api.desiredCount ?? 0,
              running: api.runningCount ?? 0,
              pending: api.pendingCount ?? 0,
              taskDefinition: api.taskDefinition
            }
          : null
      };
    } catch (error) {
      app.log.error({ err: error }, "admin_metrics_ecs_failed");
      ecs = { error: "ecs_describe_failed" };
    }
  }

  return reply.send({
    status: "ok",
    traceId: request.traceId,
    queue: { pending, counts },
    dlq: { pending: dlqPending, counts: dlqCounts },
    autoscaling: { queueDepthTarget: config.QUEUE_DEPTH_TARGET },
    ecs,
    updatedAt: new Date().toISOString()
  });
});

app.post("/v1/admin/runbook/dlq", async (request, reply) => {
  const admin = await requireAdmin(request, reply);
  if (!admin) {
    return;
  }

  if (!config.ECS_CLUSTER_ARN || !config.DLQ_REPLAY_TASK_DEFINITION_ARN) {
    return reply.code(503).send({
      error: "dlq_replay_not_configured",
      traceId: request.traceId
    });
  }

  const subnetIds = parseIdList(config.DLQ_REPLAY_SUBNET_IDS);
  const securityGroupIds = parseIdList(config.DLQ_REPLAY_SECURITY_GROUP_IDS);
  if (subnetIds.length === 0 || securityGroupIds.length === 0) {
    return reply.code(503).send({
      error: "dlq_replay_network_missing",
      traceId: request.traceId
    });
  }

  const result = await ecsClient.send(
    new RunTaskCommand({
      cluster: config.ECS_CLUSTER_ARN,
      taskDefinition: config.DLQ_REPLAY_TASK_DEFINITION_ARN,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: subnetIds,
          securityGroups: securityGroupIds,
          assignPublicIp: config.DLQ_REPLAY_ASSIGN_PUBLIC_IP
        }
      }
    })
  );

  await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
    actor: "api",
    action: "admin_runbook_triggered",
    tenantId: admin.tenant.tenantId,
    metadata: {
      taskDefinition: config.DLQ_REPLAY_TASK_DEFINITION_ARN,
      tasks: JSON.stringify(result.tasks?.map((task) => task.taskArn).filter(Boolean) ?? []),
      traceId: request.traceId
    }
  });

  return reply.send({
    status: "started",
    traceId: request.traceId,
    tasks: result.tasks?.map((task) => task.taskArn).filter(Boolean) ?? [],
    failures: result.failures ?? []
  });
});

app.post("/v1/admin/simulate/burst", async (request, reply) => {
  const admin = await requireAdmin(request, reply);
  if (!admin) {
    return;
  }

  const parsed = adminBurstSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({
      error: "validation_error",
      traceId: request.traceId,
      issues: parsed.error.flatten()
    });
  }

  const count = parsed.data.count;
  const burstId = randomUUID();
  const now = nowIso();
  const dateKey = now.slice(0, 10);
  const tenantId = admin.tenant.tenantId;
  const apiKeyFingerprint = fingerprintIdentity(`admin:${admin.apiKey}`);

  await redis.incrby(tenantActiveJobsKey(tenantId), count);
  await redis.incrby(tenantDailyJobsKey(tenantId, dateKey), count);
  await redis.expire(tenantDailyJobsKey(tenantId, dateKey), config.DAILY_QUOTA_TTL_SECONDS);

  const batchSize = 50;
  for (let offset = 0; offset < count; offset += batchSize) {
    const batch = Math.min(batchSize, count - offset);
    const tasks = [];

    for (let index = 0; index < batch; index += 1) {
      const jobId = randomUUID();
      const payload = queueJobPayloadSchema.parse({
        jobId,
        tenant: {
          tenantId,
          apiKeyFingerprint
        },
        traceId: request.traceId,
        request: {
          language: "python",
          sourceCode: `print(${offset + index + 1})`,
          stdin: "",
          timeoutMs: 3000,
          memoryMb: 128,
          cpuMillicores: 256
        },
        createdAt: now
      });

      const key = redisJobKey(jobId);
      tasks.push(
        redis.hset(key, {
          jobId,
          tenantId: payload.tenant.tenantId,
          traceId: request.traceId,
          status: "queued",
          language: payload.request.language,
          sourceCode: payload.request.sourceCode,
          stdin: payload.request.stdin ?? "",
          timeoutMs: String(payload.request.timeoutMs),
          memoryMb: String(payload.request.memoryMb),
          cpuMillicores: String(payload.request.cpuMillicores),
          maxAttempts: String(config.QUEUE_JOB_ATTEMPTS),
          attemptsMade: "0",
          currentAttempt: "1",
          createdAt: now,
          updatedAt: now
        }),
        redis.expire(key, config.JOB_TTL_SECONDS),
        appendHistoryItem(payload.tenant.tenantId, jobId),
        queue.add(jobId, payload, {
          jobId,
          attempts: config.QUEUE_JOB_ATTEMPTS,
          backoff: {
            type: "custom",
            delay: config.QUEUE_RETRY_BACKOFF_MS
          },
          removeOnComplete: { age: config.JOB_TTL_SECONDS },
          removeOnFail: { age: config.JOB_TTL_SECONDS }
        })
      );
    }

    await Promise.all(tasks);
  }

  await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
    actor: "api",
    action: "admin_burst_submitted",
    tenantId,
    metadata: { burstId, count, traceId: request.traceId }
  });

  return reply.send({
    status: "queued",
    traceId: request.traceId,
    burstId,
    count
  });
});

app.get("/v1/quotas", async (request, reply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const dateKey = utcDateKey(0);
  const [active, daily, estimatedCost] = await redis.mget(
    tenantActiveJobsKey(tenant.tenantId),
    tenantDailyJobsKey(tenant.tenantId, dateKey),
    tenantDailyCostKey(tenant.tenantId, dateKey)
  );

  return reply.send({
    tenantId: tenant.tenantId,
    traceId: request.traceId,
    authType: tenant.authType,
    limits: {
      maxConcurrentJobs: tenant.maxConcurrentJobs,
      maxDailyJobs: tenant.maxDailyJobs,
      rateLimitRequests: config.RATE_LIMIT_REQUESTS_PER_MINUTE,
      rateLimitWindowSeconds: config.RATE_LIMIT_WINDOW_SECONDS,
      submitRateLimitRequests: config.SUBMIT_RATE_LIMIT_PER_MINUTE
    },
    usage: {
      activeJobs: Number(active || 0),
      dailyJobs: Number(daily || 0),
      dailyDate: dateKey,
      estimatedCostUsd: Number(toFloat(estimatedCost, 0).toFixed(8))
    }
  });
});

app.get("/v1/costs", async (request, reply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const parsedQuery = listCostsQuerySchema.safeParse(request.query ?? {});
  if (!parsedQuery.success) {
    return reply.code(400).send({
      error: "validation_error",
      traceId: request.traceId,
      issues: parsedQuery.error.flatten()
    });
  }

  const days = parsedQuery.data.days ?? 7;
  const dateKeys = Array.from({ length: days }, (_, index) => utcDateKey(index));
  const redisKeys = dateKeys.map((dateKey) => tenantDailyCostKey(tenant.tenantId, dateKey));
  const values = redisKeys.length > 0 ? await redis.mget(...redisKeys) : [];

  const daily = dateKeys.map((dateKey, index) => ({
    date: dateKey,
    estimatedCostUsd: Number(toFloat(values[index] ?? "0", 0).toFixed(8))
  }));

  const totalEstimatedCostUsd = Number(
    daily.reduce((sum, item) => sum + item.estimatedCostUsd, 0).toFixed(8)
  );

  return reply.send({
    tenantId: tenant.tenantId,
    traceId: request.traceId,
    currency: "USD",
    windowDays: days,
    totalEstimatedCostUsd,
    daily
  });
});

const submitExecutionHandler = async (request: FastifyRequest, reply: FastifyReply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const parsed = jobRequestSchema.safeParse(request.body ?? {});

  if (!parsed.success) {
    return reply.code(400).send({
      error: "validation_error",
      traceId: request.traceId,
      issues: parsed.error.flatten()
    });
  }

  const sizeViolation = evaluatePayloadSizeLimits({
    sourceCode: parsed.data.sourceCode,
    stdin: parsed.data.stdin,
    maxSourceCodeBytes: config.MAX_SOURCE_CODE_BYTES,
    maxStdinBytes: config.MAX_STDIN_BYTES
  });
  if (sizeViolation) {
    await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
      actor: "api",
      action: "submission_rejected_size",
      tenantId: tenant.tenantId,
      metadata: {
        field: sizeViolation.field,
        bytes: sizeViolation.bytes,
        maxBytes: sizeViolation.maxBytes,
        traceId: request.traceId
      }
    });

    return reply.code(413).send({
      error: "payload_too_large",
      traceId: request.traceId,
      reason: "request_size_exceeded",
      field: sizeViolation.field,
      bytes: sizeViolation.bytes,
      maxBytes: sizeViolation.maxBytes
    });
  }

  const submitRateLimit = await evaluateSubmitRateLimit(tenant.tenantId);
  if (!submitRateLimit.allowed) {
    await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
      actor: "api",
      action: "submission_rejected_burst",
      tenantId: tenant.tenantId,
      metadata: {
        method: request.method,
        path: request.routeOptions.url ?? request.url,
        limit: submitRateLimit.limit,
        used: submitRateLimit.used,
        retryAfterSeconds: submitRateLimit.retryAfterSeconds,
        traceId: request.traceId
      }
    });

    return reply
      .code(429)
      .header("retry-after", String(submitRateLimit.retryAfterSeconds))
      .send({
        error: "submit_rate_limited",
        traceId: request.traceId,
        limit: submitRateLimit.limit,
        used: submitRateLimit.used,
        retryAfterSeconds: submitRateLimit.retryAfterSeconds,
        windowSeconds: submitRateLimit.windowSeconds
      });
  }

  const reservation = await reserveQuota(redis, tenant, config.DAILY_QUOTA_TTL_SECONDS);
  if (!reservation.allowed) {
    await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
      actor: "api",
      action: "submission_rejected_quota",
      tenantId: tenant.tenantId,
      metadata: {
        reason: reservation.reason,
        activeJobs: reservation.activeJobs,
        dailyJobs: reservation.dailyJobs,
        traceId: request.traceId
      }
    });

    return reply.code(429).send({
      error: "quota_exceeded",
      traceId: request.traceId,
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
  const key = redisJobKey(jobId);
  let payload: z.infer<typeof queueJobPayloadSchema> | null = null;

  try {
    payload = queueJobPayloadSchema.parse({
      jobId,
      tenant: {
        tenantId: tenant.tenantId,
        apiKeyFingerprint: tenant.apiKeyFingerprint
      },
      traceId: request.traceId,
      request: parsed.data,
      createdAt
    });

    await redis.hset(key, {
      jobId,
      tenantId: payload.tenant.tenantId,
      traceId: request.traceId,
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

    await queue.add(jobId, payload, {
      jobId,
      attempts: config.QUEUE_JOB_ATTEMPTS,
      backoff: {
        type: "custom",
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
      action: "job_submission_failed",
      tenantId: tenant.tenantId,
      jobId,
      metadata: {
        error: error instanceof Error ? error.message : "unknown",
        traceId: request.traceId
      }
    });

    request.log.error({ error, traceId: request.traceId }, "job_submission_failed");
    return reply.code(503).send({ error: "submission_unavailable", traceId: request.traceId });
  }

  if (!payload) {
    return reply.code(500).send({ error: "submission_unavailable", traceId: request.traceId });
  }

  await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
    actor: "api",
    action: "job_submitted",
    tenantId: tenant.tenantId,
    jobId,
    metadata: {
      authType: tenant.authType,
      subject: tenant.subject,
      language: payload.request.language,
      timeoutMs: payload.request.timeoutMs,
      memoryMb: payload.request.memoryMb,
      cpuMillicores: payload.request.cpuMillicores,
      maxAttempts: config.QUEUE_JOB_ATTEMPTS,
      traceId: request.traceId
    }
  });

  return reply.code(202).send({
    jobId,
    executionId: jobId,
    traceId: request.traceId,
    status: "queued",
    statusUrl: `/v1/jobs/${jobId}`,
    executionUrl: `/executions/${jobId}`
  });
};

app.post("/v1/jobs", submitExecutionHandler);
app.post("/executions", submitExecutionHandler);

const listExecutionsHandler = async (request: FastifyRequest, reply: FastifyReply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const parsedQuery = listJobsQuerySchema.safeParse(request.query ?? {});
  if (!parsedQuery.success) {
    return reply.code(400).send({
      error: "validation_error",
      traceId: request.traceId,
      issues: parsedQuery.error.flatten()
    });
  }

  const limit = parsedQuery.data.limit ?? config.JOB_LIST_DEFAULT_LIMIT;
  const jobIds = await redis.zrevrange(tenantJobHistoryKey(tenant.tenantId), 0, limit - 1);

  if (jobIds.length === 0) {
    return reply.send({ tenantId: tenant.tenantId, traceId: request.traceId, items: [] });
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

  return reply.send({ tenantId: tenant.tenantId, traceId: request.traceId, items });
};

app.get("/v1/jobs", listExecutionsHandler);
app.get("/executions", listExecutionsHandler);

const getExecutionHandler = async (request: FastifyRequest, reply: FastifyReply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const jobId = getJobIdParam(request);
  if (!jobId) {
    return reply.code(400).send({ error: "validation_error", traceId: request.traceId, reason: "missing_job_id" });
  }

  const key = redisJobKey(jobId);
  const data = await redis.hgetall(key);

  if (!data.status || data.tenantId !== tenant.tenantId) {
    return reply.code(404).send({ error: "not_found", traceId: request.traceId });
  }

  const execution = serializeJob(data);
  return reply.send({ ...execution, executionId: execution.jobId });
};

app.get("/v1/jobs/:jobId", getExecutionHandler);
app.get("/executions/:id", getExecutionHandler);

app.get<{ Params: { id: string } }>("/executions/:id/logs", async (request, reply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const jobId = getJobIdParam(request);
  if (!jobId) {
    return reply.code(400).send({ error: "validation_error", traceId: request.traceId, reason: "missing_job_id" });
  }

  const data = await redis.hgetall(redisJobKey(jobId));
  if (!data.status || data.tenantId !== tenant.tenantId) {
    return reply.code(404).send({ error: "not_found", traceId: request.traceId });
  }

  const execution = serializeJob(data);
  const stdout = execution.result?.stdout ?? "";
  const stderr = execution.result?.stderr ?? "";

  return reply.send({
    executionId: execution.jobId,
    traceId: request.traceId,
    status: execution.status,
    logs: {
      stdout,
      stderr
    },
    timedOut: execution.result?.timedOut ?? false,
    durationMs: execution.result?.durationMs ?? null,
    updatedAt: execution.updatedAt
  });
});

const analyzeExecutionHandler = async (request: FastifyRequest, reply: FastifyReply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const jobId = getJobIdParam(request);
  if (!jobId) {
    return reply.code(400).send({ error: "validation_error", traceId: request.traceId, reason: "missing_job_id" });
  }

  const key = redisJobKey(jobId);
  const data = await redis.hgetall(key);

  if (!data.status || data.tenantId !== tenant.tenantId) {
    return reply.code(404).send({ error: "not_found", traceId: request.traceId });
  }

  const sourceCode = (data.sourceCode || "").slice(0, config.ANALYSIS_MAX_SOURCE_CHARS);
  const { analysis, provider, fallbackReason } = await generateExecutionAnalysis(
    {
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
    },
    {
      provider: config.AI_PROVIDER,
      openAiApiKey: config.OPENAI_API_KEY,
      model: config.OPENAI_MODEL,
      timeoutMs: config.AI_ANALYSIS_TIMEOUT_MS,
      retries: config.AI_ANALYSIS_RETRIES,
      retryBackoffMs: config.AI_ANALYSIS_RETRY_BACKOFF_MS
    }
  );

  if (fallbackReason && provider === "heuristic" && config.AI_PROVIDER === "openai") {
    request.log.warn(
      {
        jobId,
        tenantId: tenant.tenantId,
        traceId: request.traceId,
        fallbackReason
      },
      "ai_analysis_heuristic_fallback"
    );
  }

  await redis.hset(key, {
    analysis: JSON.stringify(analysis),
    analysisProvider: provider,
    analysisUpdatedAt: analysis.generatedAt,
    analysisFallbackReason: fallbackReason ?? "",
    updatedAt: nowIso()
  });

  await appendAuditEvent(redis, config.AUDIT_STREAM_KEY, {
    actor: "api",
    action: "job_analyzed",
    tenantId: tenant.tenantId,
    jobId,
    metadata: {
      provider,
      confidence: analysis.confidence,
      summary: analysis.summary.slice(0, 120),
      fallbackReason: fallbackReason ?? null,
      traceId: request.traceId
    }
  });

  return reply.send({
    jobId,
    executionId: jobId,
    traceId: request.traceId,
    status: data.status,
    provider,
    analysis
  });
};

app.post("/v1/jobs/:jobId/analyze", analyzeExecutionHandler);
app.post("/executions/:id/analyze", analyzeExecutionHandler);

app.get("/v1/audit", async (request, reply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const parsedQuery = listAuditQuerySchema.safeParse(request.query ?? {});
  if (!parsedQuery.success) {
    return reply.code(400).send({
      error: "validation_error",
      traceId: request.traceId,
      issues: parsedQuery.error.flatten()
    });
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

  return reply.send({ tenantId: tenant.tenantId, traceId: request.traceId, events });
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
