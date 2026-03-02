import { z } from "zod";

const baseSchema = z.object({
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  JOB_QUEUE_NAME: z.string().min(1).default("code-jobs"),
  JOB_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  AUDIT_STREAM_KEY: z.string().min(1).default("audit:events"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(32).default(4),
  QUEUE_JOB_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  QUEUE_RETRY_BACKOFF_MS: z.coerce.number().int().positive().max(60_000).default(1_000),
  EXECUTION_BACKEND: z.enum(["local", "ecs"]).default("local"),
  RUNNER_IMAGE: z.string().min(1).default("ccee-runner:local"),
  MAX_STDIO_BYTES: z.coerce.number().int().positive().max(1_000_000).default(65_536),
  AWS_REGION: z.string().default("us-east-1"),
  ECS_CLUSTER_ARN: z.string().optional(),
  ECS_TASK_DEFINITION_ARN: z.string().optional(),
  ECS_SUBNET_IDS: z.string().optional(),
  ECS_SECURITY_GROUP_IDS: z.string().optional(),
  ECS_ASSIGN_PUBLIC_IP: z.enum(["ENABLED", "DISABLED"]).default("DISABLED"),
  ECS_RUNNER_CONTAINER_NAME: z.string().default("runner")
});

const parsed = baseSchema.parse(process.env);

const toList = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const ecsConfig = {
  clusterArn: parsed.ECS_CLUSTER_ARN,
  taskDefinitionArn: parsed.ECS_TASK_DEFINITION_ARN,
  subnetIds: toList(parsed.ECS_SUBNET_IDS),
  securityGroupIds: toList(parsed.ECS_SECURITY_GROUP_IDS),
  assignPublicIp: parsed.ECS_ASSIGN_PUBLIC_IP,
  runnerContainerName: parsed.ECS_RUNNER_CONTAINER_NAME
};

if (parsed.EXECUTION_BACKEND === "ecs") {
  if (!ecsConfig.clusterArn || !ecsConfig.taskDefinitionArn) {
    throw new Error("ECS_CLUSTER_ARN and ECS_TASK_DEFINITION_ARN are required for ecs backend");
  }

  if (ecsConfig.subnetIds.length === 0 || ecsConfig.securityGroupIds.length === 0) {
    throw new Error("ECS_SUBNET_IDS and ECS_SECURITY_GROUP_IDS are required for ecs backend");
  }
}

export const config = {
  redisUrl: parsed.REDIS_URL,
  queueName: parsed.JOB_QUEUE_NAME,
  jobTtlSeconds: parsed.JOB_TTL_SECONDS,
  auditStreamKey: parsed.AUDIT_STREAM_KEY,
  concurrency: parsed.WORKER_CONCURRENCY,
  queueJobAttempts: parsed.QUEUE_JOB_ATTEMPTS,
  queueRetryBackoffMs: parsed.QUEUE_RETRY_BACKOFF_MS,
  executionBackend: parsed.EXECUTION_BACKEND,
  runnerImage: parsed.RUNNER_IMAGE,
  maxStdioBytes: parsed.MAX_STDIO_BYTES,
  awsRegion: parsed.AWS_REGION,
  ecs: ecsConfig
};

export type WorkerConfig = typeof config;
