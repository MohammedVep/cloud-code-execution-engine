import { z } from "zod";

export const SUPPORTED_LANGUAGES = ["javascript", "python", "java"] as const;

export const jobRequestSchema = z.object({
  language: z.enum(SUPPORTED_LANGUAGES),
  sourceCode: z.string().min(1).max(100_000),
  stdin: z.string().max(100_000).optional().default(""),
  timeoutMs: z.number().int().min(100).max(15_000).optional().default(3_000),
  memoryMb: z.number().int().min(64).max(512).optional().default(128),
  cpuMillicores: z.number().int().min(128).max(1024).optional().default(256)
});

export type JobRequest = z.infer<typeof jobRequestSchema>;

export const jobStatusSchema = z.enum([
  "queued",
  "retrying",
  "running",
  "dispatched",
  "succeeded",
  "failed"
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;

export const queueJobPayloadSchema = z.object({
  jobId: z.string().uuid(),
  tenant: z.object({
    tenantId: z.string().min(1).max(128),
    apiKeyFingerprint: z.string().min(8).max(128)
  }),
  traceId: z.string().min(8).max(128).optional(),
  request: jobRequestSchema,
  createdAt: z.string()
});

export type QueueJobPayload = z.infer<typeof queueJobPayloadSchema>;

export const executionResultSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  runnerError: z.string().optional()
});

export type ExecutionResult = z.infer<typeof executionResultSchema>;

export const executionAnalysisSchema = z.object({
  summary: z.string().min(1),
  explanation: z.string().min(1),
  suggestions: z.array(z.string().min(1)).max(10),
  confidence: z.enum(["low", "medium", "high"]),
  generatedAt: z.string()
});

export type ExecutionAnalysis = z.infer<typeof executionAnalysisSchema>;

export const redisJobKey = (jobId: string): string => `job:${jobId}`;
export const tenantActiveJobsKey = (tenantId: string): string => `tenant:${tenantId}:active_jobs`;
export const tenantDailyJobsKey = (tenantId: string, dateKey: string): string =>
  `tenant:${tenantId}:daily_jobs:${dateKey}`;
export const tenantDailyCostKey = (tenantId: string, dateKey: string): string =>
  `tenant:${tenantId}:daily_cost:${dateKey}`;
export const tenantJobHistoryKey = (tenantId: string): string => `tenant:${tenantId}:job_history`;
export const tenantRateLimitKey = (tenantId: string, windowKey: string): string =>
  `tenant:${tenantId}:rate_limit:${windowKey}`;
export const tenantSubmitRateLimitKey = (tenantId: string, windowKey: string): string =>
  `tenant:${tenantId}:submit_rate_limit:${windowKey}`;

export const estimateExecutionCostUsd = (input: {
  durationMs: number;
  cpuMillicores: number;
  memoryMb: number;
}): number => {
  const durationHours = Math.max(0, input.durationMs) / (1000 * 60 * 60);
  const vCpu = Math.max(input.cpuMillicores, 128) / 1000;
  const memoryGb = Math.max(input.memoryMb, 64) / 1024;
  const cpuHourRate = 0.04048;
  const memoryGbHourRate = 0.004445;

  const estimated = durationHours * (vCpu * cpuHourRate + memoryGb * memoryGbHourRate);
  return Number(estimated.toFixed(8));
};

export const classifyFailureCategory = (input: {
  result?: ExecutionResult | null;
  errorMessage?: string | null;
}): "none" | "timeout" | "infrastructure" | "user_code" | "runtime" => {
  if (input.result?.status === "succeeded") {
    return "none";
  }

  if (input.result?.timedOut) {
    return "timeout";
  }

  const combined =
    `${input.result?.stderr ?? ""}\n${input.result?.runnerError ?? ""}\n${input.errorMessage ?? ""}`.toLowerCase();

  if (
    /eacces|docker daemon|oci runtime|containerd|dispatch failure|queue unavailable|network error/.test(combined)
  ) {
    return "infrastructure";
  }

  if (/syntaxerror|traceback|referenceerror|nameerror|exception in thread|javac/i.test(combined)) {
    return "user_code";
  }

  return "runtime";
};

export const nowIso = (): string => new Date().toISOString();
