import { createHash, randomUUID } from "node:crypto";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import {
  DescribeScalingActivitiesCommand,
  DescribeScalingPoliciesCommand,
  DescribeScalableTargetsCommand,
  ApplicationAutoScalingClient
} from "@aws-sdk/client-application-auto-scaling";
import { DescribeServicesCommand, ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import {
  LANGUAGE_RUNTIME_CATALOG,
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
import fastifyCors from "@fastify/cors";
import { Queue } from "bullmq";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Span } from "@opentelemetry/api";
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
import { endSpan, getTracer, startTelemetry } from "./telemetry.js";

declare module "fastify" {
  interface FastifyRequest {
    traceId: string;
    startedAtMs: number;
    authTenantId?: string;
    authSubject?: string;
    otelSpan?: Span;
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

const telemetrySdk = startTelemetry({
  enabled: config.OTEL_ENABLED,
  serviceName: config.OTEL_SERVICE_NAME,
  otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT
});
const tracer = getTracer();

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
const autoScalingClient = new ApplicationAutoScalingClient({ region: config.AWS_REGION });
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

const getClusterName = (clusterArnOrName: string): string => {
  if (!clusterArnOrName.includes(":")) {
    return clusterArnOrName;
  }
  const parts = clusterArnOrName.split("/");
  return parts[parts.length - 1] || clusterArnOrName;
};

const corsAllowedOrigins = config.CORS_ALLOWED_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const isAllowedOrigin = (origin: string): boolean =>
  corsAllowedOrigins.some((allowedOrigin) => {
    if (allowedOrigin === origin) {
      return true;
    }

    if (allowedOrigin.startsWith("https://*.")) {
      const suffix = allowedOrigin.slice("https://*.".length);
      return origin.startsWith("https://") && origin.slice("https://".length).endsWith(`.${suffix}`);
    }

    if (allowedOrigin.startsWith("http://*.")) {
      const suffix = allowedOrigin.slice("http://*.".length);
      return origin.startsWith("http://") && origin.slice("http://".length).endsWith(`.${suffix}`);
    }

    return false;
  });

void app.register(fastifyCors, {
  origin: (origin, callback) => {
    if (!origin || isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["authorization", "content-type", "x-api-key", "x-request-id"],
  exposedHeaders: ["x-request-id", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"],
  maxAge: 600
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
    const scaleSignal =
      pending > 0 ? Math.max(pending, Math.max(1, config.QUEUE_DEPTH_TARGET) + 1) : 0;

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
          },
          {
            MetricName: config.QUEUE_DEPTH_SCALE_METRIC_NAME,
            Dimensions: [
              { Name: "QueueName", Value: config.JOB_QUEUE_NAME },
              { Name: "Service", Value: config.QUEUE_DEPTH_METRIC_SERVICE_NAME }
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
    computeTier: data.computeTier || null,
    purchaseOption: data.purchaseOption || null,
    failureCategory: inferredFailureCategory,
    analysis: parseJson(data.analysis),
    analysisProvider: data.analysisProvider || null,
    analysisUpdatedAt: data.analysisUpdatedAt || null,
    analysisFallbackReason: data.analysisFallbackReason || null,
    error,
    runtimeMs: result?.durationMs ?? null,
    exitCode: result?.exitCode ?? null,
    timestamp: data.completedAt || data.startedAt || data.createdAt || data.updatedAt,
    executionEnvironment: data.taskArn ? "ecs-fargate-runner" : "local-runner",
    updatedAt: data.updatedAt
  };
};

type ObservabilitySnapshot = {
  windowSeconds: number;
  jobsPerSecond: number;
  averageRuntimeMs: number;
  failureRate: number;
  queueDepth: number;
  activeJobs: number;
  workerUtilization: number;
  submittedJobs: number;
  completedJobs: number;
  failedJobs: number;
  workerFleet: {
    desired: number;
    running: number;
    pending: number;
    capacity: number;
  };
  updatedAt: string;
};

const parseStreamIdMs = (streamId: string): number => {
  const [milliseconds] = streamId.split("-");
  const parsed = Number(milliseconds);
  return Number.isFinite(parsed) ? parsed : 0;
};

const readRecentAuditEvents = async (
  windowSeconds: number
): Promise<Array<{ action: string; metadata: Record<string, unknown>; streamId: string }>> => {
  const entries = await redis.xrevrange(
    config.AUDIT_STREAM_KEY,
    "+",
    "-",
    "COUNT",
    config.METRICS_SAMPLE_LIMIT
  );
  const cutoffMs = Date.now() - windowSeconds * 1000;

  return entries
    .map((entry) => {
      const [streamId, fields] = entry;
      const fieldMap = streamFieldsToObject(fields);
      return {
        streamId,
        action: fieldMap.action,
        metadata: parseJson<Record<string, unknown>>(fieldMap.metadata) ?? {}
      };
    })
    .filter((event) => parseStreamIdMs(event.streamId) >= cutoffMs);
};

const getWorkerFleetSnapshot = async (
  activeJobs: number
): Promise<ObservabilitySnapshot["workerFleet"]> => {
  if (!config.ECS_CLUSTER_ARN) {
    return {
      desired: activeJobs > 0 ? 1 : 0,
      running: activeJobs > 0 ? 1 : 0,
      pending: 0,
      capacity: config.WORKER_FLEET_CAPACITY
    };
  }

  try {
    const describe = await ecsClient.send(
      new DescribeServicesCommand({
        cluster: config.ECS_CLUSTER_ARN,
        services: [config.ECS_WORKER_SERVICE_NAME]
      })
    );
    const worker = describe.services?.[0];

    return {
      desired: worker?.desiredCount ?? 0,
      running: worker?.runningCount ?? 0,
      pending: worker?.pendingCount ?? 0,
      capacity: Math.max(config.WORKER_FLEET_CAPACITY, worker?.desiredCount ?? 0, worker?.runningCount ?? 0, 1)
    };
  } catch (error) {
    app.log.error({ err: error }, "observability_worker_fleet_failed");
    return {
      desired: 0,
      running: 0,
      pending: 0,
      capacity: config.WORKER_FLEET_CAPACITY
    };
  }
};

const getObservabilitySnapshot = async (): Promise<ObservabilitySnapshot> => {
  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "paused",
    "prioritized",
    "waiting-children"
  );
  const queueDepth =
    (counts.waiting ?? 0) +
    (counts.delayed ?? 0) +
    (counts.paused ?? 0) +
    (counts.prioritized ?? 0) +
    (counts["waiting-children"] ?? 0);
  const activeJobs = counts.active ?? 0;

  const events = await readRecentAuditEvents(config.METRICS_WINDOW_SECONDS);
  const submittedJobs = events.filter((event) => event.action === "job_submitted").length;
  const terminalEvents = events.filter(
    (event) => event.action === "job_succeeded" || event.action === "job_failed"
  );
  const failedJobs = terminalEvents.filter((event) => event.action === "job_failed").length;
  const durations = terminalEvents
    .map((event) => Number(event.metadata.durationMs))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const averageRuntimeMs =
    durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;
  const workerFleet = await getWorkerFleetSnapshot(activeJobs);
  const utilizationDenominator = Math.max(workerFleet.capacity, 1);

  return {
    windowSeconds: config.METRICS_WINDOW_SECONDS,
    jobsPerSecond: Number((submittedJobs / config.METRICS_WINDOW_SECONDS).toFixed(6)),
    averageRuntimeMs: Number(averageRuntimeMs.toFixed(2)),
    failureRate: terminalEvents.length > 0 ? Number((failedJobs / terminalEvents.length).toFixed(6)) : 0,
    queueDepth,
    activeJobs,
    workerUtilization: Number((activeJobs / utilizationDenominator).toFixed(6)),
    submittedJobs,
    completedJobs: terminalEvents.length,
    failedJobs,
    workerFleet,
    updatedAt: nowIso()
  };
};

const prometheusNumber = (value: number): string => (Number.isFinite(value) ? String(value) : "0");

const renderPrometheusMetrics = (snapshot: ObservabilitySnapshot): string =>
  [
    "# HELP ccee_jobs_per_second Submitted jobs per second over the configured window.",
    "# TYPE ccee_jobs_per_second gauge",
    `ccee_jobs_per_second ${prometheusNumber(snapshot.jobsPerSecond)}`,
    "# HELP ccee_average_runtime_ms Average terminal job runtime in milliseconds over the configured window.",
    "# TYPE ccee_average_runtime_ms gauge",
    `ccee_average_runtime_ms ${prometheusNumber(snapshot.averageRuntimeMs)}`,
    "# HELP ccee_failure_rate Ratio of failed terminal jobs over the configured window.",
    "# TYPE ccee_failure_rate gauge",
    `ccee_failure_rate ${prometheusNumber(snapshot.failureRate)}`,
    "# HELP ccee_queue_depth Pending queue depth.",
    "# TYPE ccee_queue_depth gauge",
    `ccee_queue_depth ${prometheusNumber(snapshot.queueDepth)}`,
    "# HELP ccee_worker_utilization Active jobs divided by configured or observed worker capacity.",
    "# TYPE ccee_worker_utilization gauge",
    `ccee_worker_utilization ${prometheusNumber(snapshot.workerUtilization)}`,
    "# HELP ccee_worker_running ECS or local worker tasks currently running.",
    "# TYPE ccee_worker_running gauge",
    `ccee_worker_running ${prometheusNumber(snapshot.workerFleet.running)}`,
    "# HELP ccee_worker_desired ECS or local worker desired count.",
    "# TYPE ccee_worker_desired gauge",
    `ccee_worker_desired ${prometheusNumber(snapshot.workerFleet.desired)}`,
    "# HELP ccee_worker_pending ECS worker tasks pending.",
    "# TYPE ccee_worker_pending gauge",
    `ccee_worker_pending ${prometheusNumber(snapshot.workerFleet.pending)}`,
    ""
  ].join("\n");

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
  request.otelSpan = tracer.startSpan(`${request.method} ${request.url}`);
  request.otelSpan.setAttribute("ccee.trace_id", request.traceId);
  request.otelSpan.setAttribute("http.request.method", request.method);
  request.otelSpan.setAttribute("url.path", request.url);
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
  endSpan(request.otelSpan, reply.statusCode, {
    "ccee.trace_id": request.traceId,
    "ccee.tenant_id": request.authTenantId ?? null,
    "ccee.subject": request.authSubject ?? null,
    "http.response.status_code": reply.statusCode,
    "http.route": request.routeOptions.url ?? request.url,
    "ccee.duration_ms": durationMs
  });
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

app.get("/v1/runtimes", async (request, reply) =>
  reply.send({
    traceId: request.traceId,
    runtimes: LANGUAGE_RUNTIME_CATALOG,
    isolation: {
      queue: "BullMQ/Redis asynchronous dispatch",
      workerFleet: "Horizontally scalable worker service dispatching isolated runner tasks",
      container: "Non-root container process with CPU, memory, wall-clock, process-count, file-size, stdout/stderr, and filesystem controls",
      cloud: "ECS/Fargate runner tasks run on AWS-managed Firecracker-backed Fargate isolation"
    }
  })
);

app.get("/v1/observability/summary", async (request, reply) => {
  const snapshot = await getObservabilitySnapshot();

  return reply.send({
    traceId: request.traceId,
    metrics: snapshot,
    architecture: {
      controlPlane: "Fastify API",
      queue: "BullMQ on Redis",
      workers: "Worker fleet with queue-depth autoscaling",
      execution: "Ephemeral per-job runner containers/tasks",
      observability: ["OpenTelemetry traces", "Prometheus /metrics", "Grafana dashboard provisioning"]
    }
  });
});

app.get("/metrics", async (_request, reply) => {
  const snapshot = await getObservabilitySnapshot();
  return reply.type("text/plain; version=0.0.4; charset=utf-8").send(renderPrometheusMetrics(snapshot));
});

app.get("/", async () => ({
  service: "cloudsandbox-api",
  status: "ok",
  frontend: "https://cloudsandbox.space",
  docs: {
    health: "/health",
    runtimes: "/v1/runtimes",
    submitJob: "POST /v1/jobs",
    jobEvents: "GET /v1/jobs/:jobId/events"
  }
}));

const adminBurstSchema = z.object({
  count: z.coerce.number().int().min(1).max(config.ADMIN_BURST_MAX).default(config.ADMIN_BURST_MAX)
});

// Human enhancement point: add internal SRE dashboard data here before adding UI cards.
// Keep AWS SDK calls server-side so the browser never receives cloud credentials.
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
  type AutoScalingSnapshot = {
    queueDepthTarget: number;
    targetValue?: number | null;
    policyName?: string | null;
    minCapacity?: number | null;
    maxCapacity?: number | null;
    activities?: Array<{
      statusCode: string | null;
      description: string | null;
      cause: string | null;
      startTime: string | null;
    }>;
    lastActivity?: {
      statusCode: string | null;
      description: string | null;
      cause: string | null;
      startTime: string | null;
    } | null;
    error?: string;
  };

  let autoScaling: AutoScalingSnapshot = {
    queueDepthTarget: config.QUEUE_DEPTH_TARGET
  };

  const resourceId = config.ECS_CLUSTER_ARN
    ? `service/${getClusterName(config.ECS_CLUSTER_ARN)}/${config.ECS_WORKER_SERVICE_NAME}`
    : null;
  if (resourceId) {
    try {
      const [policies, targets, activities] = await Promise.all([
        autoScalingClient.send(
          new DescribeScalingPoliciesCommand({
            ServiceNamespace: "ecs",
            ResourceId: resourceId,
            ScalableDimension: "ecs:service:DesiredCount"
          })
        ),
        autoScalingClient.send(
          new DescribeScalableTargetsCommand({
            ServiceNamespace: "ecs",
            ResourceIds: [resourceId],
            ScalableDimension: "ecs:service:DesiredCount"
          })
        ),
        autoScalingClient.send(
          new DescribeScalingActivitiesCommand({
            ServiceNamespace: "ecs",
            ResourceId: resourceId,
            ScalableDimension: "ecs:service:DesiredCount",
            MaxResults: 5
          })
        )
      ]);

      const scalingPolicies = policies.ScalingPolicies ?? [];
      const policy =
        scalingPolicies.find((candidate) => candidate.PolicyType === "TargetTrackingScaling") ??
        scalingPolicies[0];
      const target = targets.ScalableTargets?.[0];
      const recentActivities = (activities.ScalingActivities ?? []).map((activity) => ({
        statusCode: activity.StatusCode ?? null,
        description: activity.Description ?? null,
        cause: activity.Cause ?? null,
        startTime: activity.StartTime?.toISOString() ?? null
      }));
      const activity = recentActivities[0] ?? null;

      autoScaling = {
        queueDepthTarget: config.QUEUE_DEPTH_TARGET,
        targetValue: policy?.TargetTrackingScalingPolicyConfiguration?.TargetValue ?? null,
        policyName: policy?.PolicyName ?? null,
        minCapacity: target?.MinCapacity ?? null,
        maxCapacity: target?.MaxCapacity ?? null,
        activities: recentActivities,
        lastActivity: activity
      };
    } catch (error) {
      app.log.error({ err: error }, "admin_metrics_autoscaling_failed");
      autoScaling = {
        queueDepthTarget: config.QUEUE_DEPTH_TARGET,
        error: "autoscaling_describe_failed"
      };
    }
  }

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
    autoscaling: autoScaling,
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

// Human enhancement point: every new user-facing mutating route should follow
// this order: auth -> schema validation -> payload guards -> rate limit -> quota -> audit.
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

app.get("/v1/jobs/:jobId/events", async (request, reply) => {
  const tenant = await authenticateTenant(request, reply);
  if (!tenant) {
    return;
  }

  const jobId = getJobIdParam(request);
  if (!jobId) {
    return reply.code(400).send({ error: "validation_error", traceId: request.traceId, reason: "missing_job_id" });
  }

  const key = redisJobKey(jobId);
  const initial = await redis.hgetall(key);
  if (!initial.status || initial.tenantId !== tenant.tenantId) {
    return reply.code(404).send({ error: "not_found", traceId: request.traceId });
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-request-id": request.traceId
  });
  reply.raw.flushHeaders?.();

  let closed = false;
  let lastUpdatedAt = "";
  const terminalStatuses = new Set(["succeeded", "failed", "timed_out"]);

  const sendEvent = (event: string, data: unknown): void => {
    if (closed) {
      return;
    }

    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const closeStream = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(interval);
    reply.raw.end();
  };

  const publishSnapshot = async (): Promise<void> => {
    try {
      const data = await redis.hgetall(key);
      if (!data.status || data.tenantId !== tenant.tenantId) {
        sendEvent("error", { error: "not_found", traceId: request.traceId });
        closeStream();
        return;
      }

      const execution = serializeJob(data);
      if (execution.updatedAt !== lastUpdatedAt) {
        lastUpdatedAt = execution.updatedAt;
        sendEvent("job", { ...execution, executionId: execution.jobId });
      }

      if (terminalStatuses.has(String(execution.status))) {
        sendEvent("done", {
          jobId,
          executionId: jobId,
          status: execution.status,
          traceId: request.traceId
        });
        closeStream();
      }
    } catch (error) {
      request.log.error({ err: error, jobId, traceId: request.traceId }, "job_event_stream_failed");
      sendEvent("error", { error: "stream_failed", traceId: request.traceId });
      closeStream();
    }
  };

  const interval = setInterval(() => {
    void publishSnapshot();
  }, 1000);
  request.raw.on("close", closeStream);

  await publishSnapshot();
});

app.get("/executions/:id/events", async (request, reply) => {
  const params = request.params as Record<string, unknown>;
  const id = typeof params.id === "string" ? params.id : "";
  return reply.redirect(`/v1/jobs/${encodeURIComponent(id)}/events`, 307);
});

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
  await dlqQueue.close();
  await telemetrySdk?.shutdown();
  redis.disconnect();
  await app.close();
};

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

void start();
