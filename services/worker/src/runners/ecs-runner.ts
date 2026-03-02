import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import type { QueueJobPayload } from "@ccee/common";

import type { WorkerConfig } from "../config.js";

const millicoresToCpuUnits = (millicores: number): number => Math.max(128, Math.round(millicores * 1.024));

export const dispatchEcsRunner = async (
  client: ECSClient,
  config: WorkerConfig,
  payload: QueueJobPayload
): Promise<string> => {
  if (!config.ecs.clusterArn || !config.ecs.taskDefinitionArn) {
    throw new Error("ECS configuration is missing");
  }

  const jobDataB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const command = new RunTaskCommand({
    cluster: config.ecs.clusterArn,
    taskDefinition: config.ecs.taskDefinitionArn,
    launchType: "FARGATE",
    startedBy: `job-${payload.jobId}`,
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
          cpu: millicoresToCpuUnits(payload.request.cpuMillicores),
          memory: payload.request.memoryMb,
          environment: [
            { name: "RESULT_BACKEND", value: "redis" },
            { name: "REDIS_URL", value: config.redisUrl },
            { name: "AUDIT_STREAM_KEY", value: config.auditStreamKey },
            { name: "JOB_DATA_B64", value: jobDataB64 },
            { name: "MAX_STDIO_BYTES", value: String(config.maxStdioBytes) }
          ]
        }
      ]
    }
  });

  const response = await client.send(command);

  if (response.failures && response.failures.length > 0) {
    const failure = response.failures[0];
    throw new Error(`ECS dispatch failure: ${failure.reason ?? "unknown"} ${failure.detail ?? ""}`.trim());
  }

  const taskArn = response.tasks?.[0]?.taskArn;
  if (!taskArn) {
    throw new Error("ECS dispatch returned no task ARN");
  }

  return taskArn;
};
