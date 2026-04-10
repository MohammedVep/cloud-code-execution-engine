import { RunTaskCommand, type ECSClient } from "@aws-sdk/client-ecs";
import {
  type QueueJobPayload,
  type RunnerComputeTier,
  type RunnerPurchaseOption,
  selectRunnerComputeTier
} from "@ccee/common";

import type { WorkerConfig } from "../config.js";

type EcsRunTaskClient = Pick<ECSClient, "send">;

export type RunnerDispatchResult = {
  taskArn: string;
  taskDefinitionArn: string;
  computeTier: RunnerComputeTier;
  purchaseOption: RunnerPurchaseOption;
};

const isSpotCapacityFailureMessage = (message: string): boolean =>
  /(spot|resource:fargate|capacity .*unavailable|capacity.*not available|insufficient|fargate.*capacity)/i.test(
    message
  );

const buildFailureMessage = (response: { failures?: Array<{ reason?: string; detail?: string }> }): string | null => {
  const failure = response.failures?.[0];
  if (!failure) {
    return null;
  }

  return `ECS dispatch failure: ${failure.reason ?? "unknown"} ${failure.detail ?? ""}`.trim();
};

const buildContainerEnvironment = (config: WorkerConfig, payload: QueueJobPayload, billing: {
  computeTier: RunnerComputeTier;
  purchaseOption: RunnerPurchaseOption;
}): Array<{ name: string; value: string }> => [
  { name: "RESULT_BACKEND", value: "redis" },
  { name: "REDIS_URL", value: config.redisUrl },
  { name: "AUDIT_STREAM_KEY", value: config.auditStreamKey },
  { name: "JOB_DATA_B64", value: Buffer.from(JSON.stringify(payload), "utf8").toString("base64") },
  { name: "MAX_STDIO_BYTES", value: String(config.maxStdioBytes) },
  { name: "RUNNER_COMPUTE_TIER", value: billing.computeTier },
  { name: "RUNNER_PURCHASE_OPTION", value: billing.purchaseOption }
];

const sendRunTask = async (
  client: EcsRunTaskClient,
  config: WorkerConfig,
  payload: QueueJobPayload,
  execution: {
    taskDefinitionArn: string;
    computeTier: RunnerComputeTier;
    purchaseOption: RunnerPurchaseOption;
    useSpotCapacity: boolean;
  }
): Promise<string> => {
  const response = await client.send(
    new RunTaskCommand({
      cluster: config.ecs.clusterArn,
      taskDefinition: execution.taskDefinitionArn,
      startedBy: `job-${payload.jobId}`,
      launchType: execution.useSpotCapacity ? undefined : "FARGATE",
      capacityProviderStrategy: execution.useSpotCapacity
        ? [
            {
              capacityProvider: "FARGATE_SPOT",
              weight: 1
            }
          ]
        : undefined,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: config.ecs.subnetIds,
          securityGroups: config.ecs.securityGroupIds,
          assignPublicIp: config.ecs.assignPublicIp
        }
      },
      overrides: {
        containerOverrides: [
          {
            name: config.ecs.runnerContainerName,
            environment: buildContainerEnvironment(config, payload, execution)
          }
        ]
      }
    })
  );

  const failureMessage = buildFailureMessage(response);
  if (failureMessage) {
    throw new Error(failureMessage);
  }

  const taskArn = response.tasks?.[0]?.taskArn;
  if (!taskArn) {
    throw new Error("ECS dispatch returned no task ARN");
  }

  return taskArn;
};

const getTaskDefinitionArn = (config: WorkerConfig, computeTier: RunnerComputeTier): string => {
  const taskDefinitionArn = config.ecs.taskDefinitionArns[computeTier];
  if (!taskDefinitionArn) {
    throw new Error(`Missing ECS task definition ARN for compute tier ${computeTier}`);
  }

  return taskDefinitionArn;
};

export const dispatchEcsRunner = async (
  client: EcsRunTaskClient,
  config: WorkerConfig,
  payload: QueueJobPayload
): Promise<RunnerDispatchResult> => {
  if (!config.ecs.clusterArn) {
    throw new Error("ECS configuration is missing");
  }

  const computeTier = selectRunnerComputeTier(payload.request.cpuMillicores);
  const taskDefinitionArn = getTaskDefinitionArn(config, computeTier);

  if (!config.ecs.spotEnabled) {
    const taskArn = await sendRunTask(client, config, payload, {
      taskDefinitionArn,
      computeTier,
      purchaseOption: "on-demand",
      useSpotCapacity: false
    });

    return {
      taskArn,
      taskDefinitionArn,
      computeTier,
      purchaseOption: "on-demand"
    };
  }

  try {
    const taskArn = await sendRunTask(client, config, payload, {
      taskDefinitionArn,
      computeTier,
      purchaseOption: "spot",
      useSpotCapacity: true
    });

    return {
      taskArn,
      taskDefinitionArn,
      computeTier,
      purchaseOption: "spot"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    if (!config.ecs.onDemandFallbackEnabled || !isSpotCapacityFailureMessage(message)) {
      throw error;
    }

    const taskArn = await sendRunTask(client, config, payload, {
      taskDefinitionArn,
      computeTier,
      purchaseOption: "on-demand",
      useSpotCapacity: false
    });

    return {
      taskArn,
      taskDefinitionArn,
      computeTier,
      purchaseOption: "on-demand"
    };
  }
};
