import test from "node:test";
import assert from "node:assert/strict";
import type { ECSClient } from "@aws-sdk/client-ecs";

import { dispatchEcsRunner } from "./ecs-runner.js";

const createConfig = () => ({
  redisUrl: "redis://localhost:6379",
  queueName: "code-jobs",
  jobTtlSeconds: 86400,
  auditStreamKey: "audit:events",
  concurrency: 4,
  queueJobAttempts: 3,
  queueRetryBackoffMs: 1000,
  queueRetryMaxDelayMs: 60000,
  dlqQueueName: "code-jobs-dlq",
  executionBackend: "ecs" as const,
  runnerImage: "ccee-runner:local",
  maxStdioBytes: 65536,
  awsRegion: "us-east-1",
  ecs: {
    clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/ccee-cluster",
    taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/ccee-runner-medium:1",
    taskDefinitionArns: {
      small: "arn:aws:ecs:us-east-1:123456789012:task-definition/ccee-runner-small:1",
      medium: "arn:aws:ecs:us-east-1:123456789012:task-definition/ccee-runner-medium:1",
      large: "arn:aws:ecs:us-east-1:123456789012:task-definition/ccee-runner-large:1"
    },
    subnetIds: ["subnet-123"],
    securityGroupIds: ["sg-123"],
    assignPublicIp: "ENABLED" as const,
    runnerContainerName: "runner",
    spotEnabled: true,
    onDemandFallbackEnabled: true
  },
  queueDepthMetric: {
    namespace: "CCEE",
    metricName: "PendingJobsCount",
    scaleMetricName: "PendingJobsScaleSignal",
    target: 25,
    publishIntervalMs: 30000,
    serviceName: "ccee-worker"
  }
});

const createPayload = (cpuMillicores: number) => ({
  jobId: "4c663c65-3d4c-4d7a-905e-c96c7687a0de",
  tenant: {
    tenantId: "tenant-dev",
    apiKeyFingerprint: "abcdef1234567890"
  },
  traceId: "trace-12345678",
  createdAt: "2026-04-03T12:00:00.000Z",
  request: {
    language: "python" as const,
    sourceCode: "print(42)",
    stdin: "",
    timeoutMs: 3000,
    memoryMb: 128,
    cpuMillicores
  }
});

test("dispatchEcsRunner selects small tier and Fargate Spot by default", async () => {
  const commands: Array<{ input: Record<string, unknown> }> = [];
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      commands.push(command);
      return { tasks: [{ taskArn: "arn:aws:ecs:task/spot" }] };
    }
  } satisfies Pick<ECSClient, "send">;

  const result = await dispatchEcsRunner(client, createConfig(), createPayload(256));

  assert.deepEqual(result, {
    taskArn: "arn:aws:ecs:task/spot",
    taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/ccee-runner-small:1",
    computeTier: "small",
    purchaseOption: "spot"
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].input.taskDefinition, result.taskDefinitionArn);
  assert.deepEqual(commands[0].input.capacityProviderStrategy, [{ capacityProvider: "FARGATE_SPOT", weight: 1 }]);

  const environment = (
    (commands[0].input.overrides as { containerOverrides: Array<{ environment: Array<{ name: string; value: string }> }> })
      .containerOverrides[0].environment
  );
  assert.deepEqual(
    environment.filter((entry) => entry.name.startsWith("RUNNER_")),
    [
      { name: "RUNNER_COMPUTE_TIER", value: "small" },
      { name: "RUNNER_PURCHASE_OPTION", value: "spot" }
    ]
  );
});

test("dispatchEcsRunner falls back to on-demand when Spot capacity is unavailable", async () => {
  const commands: Array<{ input: Record<string, unknown> }> = [];
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      commands.push(command);
      if (commands.length === 1) {
        return {
          failures: [
            {
              reason: "RESOURCE:FARGATE",
              detail: "Fargate Spot capacity is unavailable right now"
            }
          ]
        };
      }

      return { tasks: [{ taskArn: "arn:aws:ecs:task/on-demand" }] };
    }
  } satisfies Pick<ECSClient, "send">;

  const result = await dispatchEcsRunner(client, createConfig(), createPayload(768));

  assert.equal(result.computeTier, "large");
  assert.equal(result.purchaseOption, "on-demand");
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].input.capacityProviderStrategy, [{ capacityProvider: "FARGATE_SPOT", weight: 1 }]);
  assert.equal(commands[1].input.launchType, "FARGATE");
  assert.equal(commands[1].input.taskDefinition, "arn:aws:ecs:us-east-1:123456789012:task-definition/ccee-runner-large:1");
});
