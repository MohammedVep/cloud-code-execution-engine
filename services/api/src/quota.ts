import { tenantActiveJobsKey, tenantDailyJobsKey } from "@ccee/common";
import type { Redis } from "ioredis";

import type { TenantPrincipal } from "./tenants.js";

export type QuotaReservation =
  | {
      allowed: true;
      activeJobs: number;
      dailyJobs: number;
      dateKey: string;
    }
  | {
      allowed: false;
      reason: "max_concurrent_jobs" | "max_daily_jobs";
      activeJobs: number;
      dailyJobs: number;
      dateKey: string;
    };

const reserveScript = `
local activeKey = KEYS[1]
local dailyKey = KEYS[2]
local maxActive = tonumber(ARGV[1])
local maxDaily = tonumber(ARGV[2])
local dailyTtl = tonumber(ARGV[3])

local active = tonumber(redis.call("GET", activeKey) or "0")
if active >= maxActive then
  return {0, "max_concurrent_jobs", active, tonumber(redis.call("GET", dailyKey) or "0")}
end

local daily = tonumber(redis.call("GET", dailyKey) or "0")
if daily >= maxDaily then
  return {0, "max_daily_jobs", active, daily}
end

active = redis.call("INCR", activeKey)
daily = redis.call("INCR", dailyKey)
if daily == 1 then
  redis.call("EXPIRE", dailyKey, dailyTtl)
end

return {1, "ok", active, daily}
`;

export const reserveQuota = async (
  redis: Redis,
  tenant: TenantPrincipal,
  dailyTtlSeconds: number
): Promise<QuotaReservation> => {
  const dateKey = new Date().toISOString().slice(0, 10);

  const result = (await redis.eval(
    reserveScript,
    2,
    tenantActiveJobsKey(tenant.tenantId),
    tenantDailyJobsKey(tenant.tenantId, dateKey),
    String(tenant.maxConcurrentJobs),
    String(tenant.maxDailyJobs),
    String(dailyTtlSeconds)
  )) as [number, string, number, number];

  const [allowed, reason, activeJobs, dailyJobs] = result;

  if (allowed === 1) {
    return {
      allowed: true,
      activeJobs,
      dailyJobs,
      dateKey
    };
  }

  return {
    allowed: false,
    reason: reason as "max_concurrent_jobs" | "max_daily_jobs",
    activeJobs,
    dailyJobs,
    dateKey
  };
};

export const rollbackReservedQuota = async (
  redis: Redis,
  tenantId: string,
  dateKey: string
): Promise<void> => {
  const activeKey = tenantActiveJobsKey(tenantId);
  const dailyKey = tenantDailyJobsKey(tenantId, dateKey);

  const rollbackScript = `
  local activeKey = KEYS[1]
  local dailyKey = KEYS[2]

  local active = tonumber(redis.call("GET", activeKey) or "0")
  if active > 0 then
    redis.call("DECR", activeKey)
  end

  local daily = tonumber(redis.call("GET", dailyKey) or "0")
  if daily > 0 then
    redis.call("DECR", dailyKey)
  end

  return 1
  `;

  await redis.eval(rollbackScript, 2, activeKey, dailyKey);
};
