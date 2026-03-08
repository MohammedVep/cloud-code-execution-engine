import { z } from "zod";

const envSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(8080),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  AUTH_MODE: z.enum(["api_key", "jwt", "hybrid"]).default("api_key"),
  JWT_JWKS_URL: z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
    z.string().url().optional()
  ),
  JWT_ISSUER: z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
    z.string().min(1).optional()
  ),
  JWT_AUDIENCE: z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
    z.string().min(1).optional()
  ),
  JWT_TENANT_CLAIM: z.string().min(1).default("custom:tenant_id"),
  JWT_SUBJECT_CLAIM: z.string().min(1).default("sub"),
  RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().max(100_000).default(240),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  SUBMIT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().max(100_000).default(60),
  MAX_SOURCE_CODE_BYTES: z.coerce.number().int().positive().max(1_000_000).default(100_000),
  MAX_STDIN_BYTES: z.coerce.number().int().positive().max(1_000_000).default(100_000),
  JOB_QUEUE_NAME: z.string().min(1).default("code-jobs"),
  DLQ_QUEUE_NAME: z.string().min(1).default("code-jobs-dlq"),
  JOB_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  JOB_HISTORY_MAX: z.coerce.number().int().positive().max(10_000).default(500),
  JOB_LIST_DEFAULT_LIMIT: z.coerce.number().int().positive().max(200).default(20),
  JOB_LIST_MAX_LIMIT: z.coerce.number().int().positive().max(500).default(100),
  AUDIT_STREAM_KEY: z.string().min(1).default("audit:events"),
  DAILY_QUOTA_TTL_SECONDS: z.coerce.number().int().positive().default(172_800),
  QUEUE_JOB_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  QUEUE_RETRY_BACKOFF_MS: z.coerce.number().int().positive().max(60_000).default(1_000),
  ANALYSIS_MAX_SOURCE_CHARS: z.coerce.number().int().positive().max(50_000).default(8_000),
  QUEUE_DEPTH_TARGET: z.coerce.number().int().positive().max(10_000).default(25),
  QUEUE_DEPTH_METRIC_NAMESPACE: z.string().min(1).default("CCEE"),
  QUEUE_DEPTH_METRIC_NAME: z.string().min(1).default("PendingJobsCount"),
  QUEUE_DEPTH_PUBLISH_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  QUEUE_DEPTH_METRIC_SERVICE_NAME: z.string().min(1).default("ccee-worker"),
  ECS_CLUSTER_ARN: z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
    z.string().min(1).optional()
  ),
  ECS_WORKER_SERVICE_NAME: z.string().min(1).default("ccee-worker"),
  ECS_API_SERVICE_NAME: z.string().min(1).default("ccee-api"),
  DLQ_REPLAY_TASK_DEFINITION_ARN: z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
    z.string().min(1).optional()
  ),
  DLQ_REPLAY_SUBNET_IDS: z
    .string()
    .default("")
    .transform((value) => value.trim()),
  DLQ_REPLAY_SECURITY_GROUP_IDS: z
    .string()
    .default("")
    .transform((value) => value.trim()),
  DLQ_REPLAY_ASSIGN_PUBLIC_IP: z.enum(["ENABLED", "DISABLED"]).default("DISABLED"),
  ADMIN_API_KEYS_JSON: z.string().default(JSON.stringify(["dev-local-key"])),
  ADMIN_BURST_MAX: z.coerce.number().int().positive().max(10_000).default(1_000),
  AI_PROVIDER: z.enum(["none", "openai"]).default("none"),
  OPENAI_API_KEY: z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
    z.string().min(20).optional()
  ),
  OPENAI_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  AI_ANALYSIS_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  AI_ANALYSIS_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AI_ANALYSIS_RETRY_BACKOFF_MS: z.coerce.number().int().min(50).max(10_000).default(500),
  TENANT_POLICIES_JSON: z.string().default("{}"),
  TENANT_API_KEYS_JSON: z
    .string()
    .default(
      JSON.stringify({
        "dev-local-key": {
          tenantId: "tenant-dev",
          maxConcurrentJobs: 5,
          maxDailyJobs: 1_000
        }
      })
    )
});

export type ApiConfig = z.infer<typeof envSchema>;

const parsed = envSchema.parse(process.env);

if (parsed.AI_PROVIDER === "openai" && !parsed.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
}

if (parsed.AUTH_MODE === "jwt" && (!parsed.JWT_JWKS_URL || !parsed.JWT_ISSUER)) {
  throw new Error("JWT_JWKS_URL and JWT_ISSUER are required when AUTH_MODE=jwt");
}

export const config: ApiConfig = parsed;
