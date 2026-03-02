import { spawn } from "node:child_process";

import { executionResultSchema, type ExecutionResult, type QueueJobPayload } from "@ccee/common";

const truncateBuffer = (value: string, maxBytes: number): string => {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }

  return buffer.subarray(0, maxBytes).toString("utf8");
};

const parseResultFromStdout = (stdout: string): ExecutionResult | null => {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  const candidate = lines[lines.length - 1];

  try {
    const data = JSON.parse(candidate);
    return executionResultSchema.parse(data);
  } catch {
    return null;
  }
};

export const executeLocalRunner = async (
  payload: QueueJobPayload,
  runnerImage: string,
  maxStdioBytes: number
): Promise<ExecutionResult> => {
  const jobDataB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const cpuCores = Math.max(payload.request.cpuMillicores / 1000, 0.125).toFixed(3);
  const memoryMb = payload.request.memoryMb;

  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    "1000:1000",
    "--pids-limit",
    "64",
    "--cpus",
    cpuCores,
    "--memory",
    `${memoryMb}m`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--tmpfs",
    "/workspace:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=1770",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "-e",
    "RESULT_BACKEND=stdout",
    "-e",
    "RUN_ROOT=/workspace",
    "-e",
    `MAX_STDIO_BYTES=${maxStdioBytes}`,
    "-e",
    `JOB_DATA_B64=${jobDataB64}`,
    runnerImage
  ];

  const child = spawn("docker", args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    stdout = truncateBuffer(stdout, maxStdioBytes * 2);
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    stderr = truncateBuffer(stderr, maxStdioBytes);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });

  const parsedResult = parseResultFromStdout(stdout);
  if (parsedResult) {
    return parsedResult;
  }

  const likelyInfraFailure =
    exitCode === null ||
    exitCode === 125 ||
    /Cannot connect to the Docker daemon/i.test(stderr) ||
    /No such image/i.test(stderr) ||
    /OCI runtime/i.test(stderr) ||
    /containerd/i.test(stderr);

  if (likelyInfraFailure) {
    throw new Error(`Runner infrastructure failure (exit=${String(exitCode)}): ${truncateBuffer(stderr, 400)}`);
  }

  return {
    status: "failed",
    exitCode,
    signal: null,
    timedOut: false,
    stdout: truncateBuffer(stdout, maxStdioBytes),
    stderr: truncateBuffer(stderr, maxStdioBytes),
    durationMs: 0,
    runnerError: "Runner did not return a valid result payload"
  };
};
