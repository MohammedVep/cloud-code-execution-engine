import { z } from "zod";

// Human enhancement point: every new runtime starts here, then gets a runner profile.
// Keep this list small and only add languages with matching sandbox/runtime tests.
export const SUPPORTED_LANGUAGES = [
  "java",
  "python",
  "go",
  "javascript",
  "typescript",
  "cpp",
  "csharp"
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export type LanguageRuntime = {
  language: SupportedLanguage;
  displayName: string;
  sourceFile: string;
  runtime: string;
  pipeline: string[];
  environment: string;
  isolation: string[];
};

export const LANGUAGE_RUNTIME_CATALOG: LanguageRuntime[] = [
  {
    language: "java",
    displayName: "Java",
    sourceFile: "Main.java",
    runtime: "OpenJDK 17",
    pipeline: ["javac Main.java", "java -Xmx<memory>m Main"],
    environment: "Compiled JVM runtime inside an ephemeral container workspace",
    isolation: ["Fargate/Firecracker task boundary", "non-root user", "CPU/memory/time/pid/file limits"]
  },
  {
    language: "python",
    displayName: "Python",
    sourceFile: "main.py",
    runtime: "Python 3",
    pipeline: ["python3 main.py"],
    environment: "Interpreted runtime inside an ephemeral container workspace",
    isolation: ["Fargate/Firecracker task boundary", "non-root user", "CPU/memory/time/pid/file limits"]
  },
  {
    language: "go",
    displayName: "Go",
    sourceFile: "main.go",
    runtime: "Go toolchain",
    pipeline: ["go build -o main main.go", "./main"],
    environment: "Compiled native binary inside an ephemeral container workspace",
    isolation: ["Fargate/Firecracker task boundary", "non-root user", "CPU/memory/time/pid/file limits"]
  },
  {
    language: "javascript",
    displayName: "JavaScript",
    sourceFile: "main.js",
    runtime: "Node.js 20",
    pipeline: ["node main.js"],
    environment: "Interpreted Node.js runtime inside an ephemeral container workspace",
    isolation: ["Fargate/Firecracker task boundary", "non-root user", "CPU/memory/time/pid/file limits"]
  },
  {
    language: "typescript",
    displayName: "TypeScript",
    sourceFile: "main.ts",
    runtime: "TypeScript compiler + Node.js 20",
    pipeline: ["tsc main.ts --outDir .build", "node .build/main.js"],
    environment: "Compiled-to-JavaScript runtime inside an ephemeral container workspace",
    isolation: ["Fargate/Firecracker task boundary", "non-root user", "CPU/memory/time/pid/file limits"]
  },
  {
    language: "cpp",
    displayName: "C++",
    sourceFile: "main.cpp",
    runtime: "g++ C++20",
    pipeline: ["g++ main.cpp -std=c++20 -O2 -pipe -o main", "./main"],
    environment: "Compiled native binary inside an ephemeral container workspace",
    isolation: ["Fargate/Firecracker task boundary", "non-root user", "CPU/memory/time/pid/file limits"]
  },
  {
    language: "csharp",
    displayName: "C#",
    sourceFile: "Program.cs",
    runtime: "Mono C# compiler/runtime",
    pipeline: ["mcs -out:Program.exe Program.cs", "mono Program.exe"],
    environment: "Compiled CLR executable inside an ephemeral container workspace",
    isolation: ["Fargate/Firecracker task boundary", "non-root user", "CPU/memory/time/pid/file limits"]
  }
];

// This schema is the public contract for job submission. Prefer additive fields
// with defaults so older clients and demos keep working.
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

export const RUNNER_COMPUTE_TIERS = ["small", "medium", "large"] as const;
export type RunnerComputeTier = (typeof RUNNER_COMPUTE_TIERS)[number];

export const RUNNER_PURCHASE_OPTIONS = ["spot", "on-demand"] as const;
export type RunnerPurchaseOption = (typeof RUNNER_PURCHASE_OPTIONS)[number];

const runnerTierResources = {
  small: {
    cpuUnits: 256,
    memoryMb: 512
  },
  medium: {
    cpuUnits: 512,
    memoryMb: 1024
  },
  large: {
    cpuUnits: 1024,
    memoryMb: 2048
  }
} as const satisfies Record<RunnerComputeTier, { cpuUnits: number; memoryMb: number }>;

export const getRunnerTierResources = (
  computeTier: RunnerComputeTier
): { cpuUnits: number; memoryMb: number } => runnerTierResources[computeTier];

export const selectRunnerComputeTier = (cpuMillicores: number): RunnerComputeTier => {
  if (cpuMillicores <= 256) {
    return "small";
  }

  if (cpuMillicores <= 512) {
    return "medium";
  }

  return "large";
};

export const resolveCostModelVersion = (input: {
  computeTier?: RunnerComputeTier | null;
  purchaseOption?: RunnerPurchaseOption | null;
}): string => {
  if (input.computeTier && input.purchaseOption) {
    return "fargate-tiered-v2";
  }

  return "fargate-v1";
};

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
  cpuMillicores?: number;
  memoryMb?: number;
  computeTier?: RunnerComputeTier | null;
  purchaseOption?: RunnerPurchaseOption | null;
}): number => {
  const durationHours = Math.max(0, input.durationMs) / (1000 * 60 * 60);
  const tierResources = input.computeTier ? getRunnerTierResources(input.computeTier) : null;
  const vCpu = tierResources
    ? tierResources.cpuUnits / 1024
    : Math.max(input.cpuMillicores ?? 128, 128) / 1000;
  const memoryGb = tierResources
    ? tierResources.memoryMb / 1024
    : Math.max(input.memoryMb ?? 64, 64) / 1024;
  const cpuHourRate = 0.04048;
  const memoryGbHourRate = 0.004445;
  const purchaseMultiplier = input.purchaseOption === "spot" ? 0.3 : 1;

  const estimated = durationHours * (vCpu * cpuHourRate + memoryGb * memoryGbHourRate) * purchaseMultiplier;
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
