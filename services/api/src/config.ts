import { z } from "zod";

const envSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(8080),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  JOB_QUEUE_NAME: z.string().min(1).default("code-jobs"),
  JOB_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  JOB_HISTORY_MAX: z.coerce.number().int().positive().max(10_000).default(500),
  JOB_LIST_DEFAULT_LIMIT: z.coerce.number().int().positive().max(200).default(20),
  JOB_LIST_MAX_LIMIT: z.coerce.number().int().positive().max(500).default(100),
  AUDIT_STREAM_KEY: z.string().min(1).default("audit:events"),
  DAILY_QUOTA_TTL_SECONDS: z.coerce.number().int().positive().default(172_800),
  QUEUE_JOB_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  QUEUE_RETRY_BACKOFF_MS: z.coerce.number().int().positive().max(60_000).default(1_000),
  ANALYSIS_MAX_SOURCE_CHARS: z.coerce.number().int().positive().max(50_000).default(8_000),
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

export const config: ApiConfig = envSchema.parse(process.env);
