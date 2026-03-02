import { nowIso } from "@ccee/common";
import type { Redis } from "ioredis";

export type AuditEvent = {
  actor: "api" | "worker" | "runner";
  action: string;
  tenantId?: string;
  jobId?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export const appendAuditEvent = async (
  redis: Redis,
  streamKey: string,
  event: AuditEvent
): Promise<void> => {
  await redis.xadd(
    streamKey,
    "*",
    "timestamp",
    nowIso(),
    "actor",
    event.actor,
    "action",
    event.action,
    "tenantId",
    event.tenantId ?? "",
    "jobId",
    event.jobId ?? "",
    "metadata",
    JSON.stringify(event.metadata ?? {})
  );
};
