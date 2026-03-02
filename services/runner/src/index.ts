import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executionResultSchema,
  nowIso,
  queueJobPayloadSchema,
  redisJobKey,
  tenantActiveJobsKey,
  type ExecutionResult
} from "@ccee/common";
import { Redis } from "ioredis";
import { z } from "zod";

const envSchema = z.object({
  JOB_DATA_B64: z.string().min(1),
  RESULT_BACKEND: z.enum(["stdout", "redis"]).default("stdout"),
  REDIS_URL: z.string().url().optional(),
  AUDIT_STREAM_KEY: z.string().min(1).default("audit:events"),
  MAX_STDIO_BYTES: z.coerce.number().int().positive().max(1_000_000).default(65_536),
  RUN_ROOT: z.string().min(1).optional()
});

const truncate = (input: string, maxBytes: number): string => {
  const buffer = Buffer.from(input, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return input;
  }

  return buffer.subarray(0, maxBytes).toString("utf8");
};

type RuntimeStep = {
  command: string;
  args: string[];
  stdin?: string;
};

type RuntimePlan = {
  fileName: string;
  steps: RuntimeStep[];
};

const detectJavaClassName = (sourceCode: string): string => {
  const match = sourceCode.match(/public\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (match?.[1]) {
    return match[1];
  }

  return "Main";
};

const getRuntimePlan = (
  language: string,
  sourceCode: string,
  stdin: string,
  memoryMb: number
): RuntimePlan => {
  if (language === "javascript") {
    return {
      fileName: "main.js",
      steps: [{ command: "node", args: ["main.js"], stdin }]
    };
  }

  if (language === "python") {
    return {
      fileName: "main.py",
      steps: [{ command: "python3", args: ["main.py"], stdin }]
    };
  }

  if (language === "java") {
    const className = detectJavaClassName(sourceCode);
    const maxHeap = Math.max(64, Math.floor(memoryMb * 0.75));

    return {
      fileName: `${className}.java`,
      steps: [
        { command: "javac", args: [`${className}.java`] },
        { command: "java", args: [`-Xmx${maxHeap}m`, className], stdin }
      ]
    };
  }

  throw new Error(`Unsupported language: ${language}`);
};

type ProcessOutcome = {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const runLimitedProcess = async (params: {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  maxStdioBytes: number;
}): Promise<ProcessOutcome> => {
  const cpuSeconds = Math.max(1, Math.ceil(params.timeoutMs / 1000) + 1);

  const child = spawn(
    "prlimit",
    [
      `--cpu=${cpuSeconds}`,
      "--nproc=64",
      "--fsize=1048576",
      "--",
      params.command,
      ...params.args
    ],
    {
      cwd: params.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    stdout = truncate(stdout, params.maxStdioBytes);
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    stderr = truncate(stderr, params.maxStdioBytes);
  });

  if (params.stdin !== undefined) {
    child.stdin.end(params.stdin, "utf8");
  } else {
    child.stdin.end();
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, params.timeoutMs);

  const closeData = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  clearTimeout(timeout);

  return {
    code: closeData.code,
    signal: closeData.signal,
    stdout,
    stderr,
    timedOut
  };
};

const executeUserCode = async (
  jobDataBase64: string,
  maxStdioBytes: number,
  runRootOverride?: string
): Promise<{ jobId: string; tenantId: string; result: ExecutionResult }> => {
  const decoded = Buffer.from(jobDataBase64, "base64").toString("utf8");
  const payload = queueJobPayloadSchema.parse(JSON.parse(decoded));
  const runtime = getRuntimePlan(
    payload.request.language,
    payload.request.sourceCode,
    payload.request.stdin,
    payload.request.memoryMb
  );

  const runRoot = runRootOverride || tmpdir();
  await mkdir(runRoot, { recursive: true });

  const runDir = await mkdtemp(join(runRoot, "ccee-job-"));
  const sourcePath = join(runDir, runtime.fileName);

  const startedAt = Date.now();

  try {
    await writeFile(sourcePath, payload.request.sourceCode, { encoding: "utf8", mode: 0o600 });

    const deadline = startedAt + payload.request.timeoutMs;
    let combinedStdout = "";
    let combinedStderr = "";
    let finalCode: number | null = null;
    let finalSignal: string | null = null;
    let timedOut = false;

    for (const step of runtime.steps) {
      const remainingMs = Math.max(100, deadline - Date.now());

      const stepResult = await runLimitedProcess({
        command: step.command,
        args: step.args,
        cwd: runDir,
        stdin: step.stdin,
        timeoutMs: remainingMs,
        maxStdioBytes
      });

      combinedStdout = truncate(`${combinedStdout}${stepResult.stdout}`, maxStdioBytes);
      combinedStderr = truncate(`${combinedStderr}${stepResult.stderr}`, maxStdioBytes);
      finalCode = stepResult.code;
      finalSignal = stepResult.signal;

      if (stepResult.timedOut) {
        timedOut = true;
        break;
      }

      if (stepResult.code !== 0) {
        break;
      }
    }

    const durationMs = Date.now() - startedAt;
    const result = executionResultSchema.parse({
      status: finalCode === 0 && !timedOut ? "succeeded" : "failed",
      exitCode: finalCode,
      signal: finalSignal,
      timedOut,
      stdout: truncate(combinedStdout, maxStdioBytes),
      stderr: truncate(combinedStderr, maxStdioBytes),
      durationMs
    });

    return { jobId: payload.jobId, tenantId: payload.tenant.tenantId, result };
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
};

const persistResultToRedis = async (
  redisUrl: string,
  jobId: string,
  tenantId: string,
  result: ExecutionResult,
  auditStreamKey: string
): Promise<void> => {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  const now = nowIso();

  await redis.hset(redisJobKey(jobId), {
    status: result.status,
    result: JSON.stringify(result),
    currentAttempt: "",
    retryScheduledAt: "",
    completedAt: now,
    updatedAt: now,
    error: ""
  });

  const releaseScript = `
  local activeKey = KEYS[1]
  local active = tonumber(redis.call("GET", activeKey) or "0")
  if active > 0 then
    redis.call("DECR", activeKey)
  end
  return 1
  `;

  await redis.eval(releaseScript, 1, tenantActiveJobsKey(tenantId));
  await redis.xadd(
    auditStreamKey,
    "*",
    "timestamp",
    now,
    "actor",
    "runner",
    "action",
    result.status === "succeeded" ? "job_succeeded" : "job_failed",
    "tenantId",
    tenantId,
    "jobId",
    jobId,
    "metadata",
    JSON.stringify({
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      durationMs: result.durationMs
    })
  );

  await redis.quit();
};

const run = async (): Promise<void> => {
  const env = envSchema.parse(process.env);

  const { jobId, tenantId, result } = await executeUserCode(
    env.JOB_DATA_B64,
    env.MAX_STDIO_BYTES,
    env.RUN_ROOT
  );

  if (env.RESULT_BACKEND === "redis") {
    if (!env.REDIS_URL) {
      throw new Error("REDIS_URL is required when RESULT_BACKEND=redis");
    }

    await persistResultToRedis(env.REDIS_URL, jobId, tenantId, result, env.AUDIT_STREAM_KEY);
    return;
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
};

run().catch(async (error) => {
  const fallback: ExecutionResult = {
    status: "failed",
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    durationMs: 0,
    runnerError: error instanceof Error ? error.message : "Unknown runner failure"
  };

  const env = envSchema.safeParse(process.env);
  if (env.success && env.data.RESULT_BACKEND === "redis" && env.data.REDIS_URL) {
    try {
      const payload = queueJobPayloadSchema.parse(
        JSON.parse(Buffer.from(env.data.JOB_DATA_B64, "base64").toString("utf8"))
      );

      await persistResultToRedis(
        env.data.REDIS_URL,
        payload.jobId,
        payload.tenant.tenantId,
        fallback,
        env.data.AUDIT_STREAM_KEY
      );

      process.exit(1);
      return;
    } catch {
      // Fall through to stdout fallback.
    }
  }

  process.stdout.write(`${JSON.stringify(fallback)}\n`);
  process.exit(1);
});
