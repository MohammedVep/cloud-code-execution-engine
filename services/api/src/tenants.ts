import { createHash } from "node:crypto";

import { z } from "zod";

const tenantPolicyLimitsSchema = z.object({
  maxConcurrentJobs: z.coerce.number().int().positive().max(1_000).default(5),
  maxDailyJobs: z.coerce.number().int().positive().max(1_000_000).default(1_000)
});

const tenantPolicySchema = tenantPolicyLimitsSchema.extend({
  tenantId: z.string().min(1).max(128),
});

const tenantApiKeyMapSchema = z.record(tenantPolicySchema);
const tenantPolicyMapSchema = z.record(tenantPolicyLimitsSchema);

export type TenantPolicy = z.infer<typeof tenantPolicySchema>;

export type TenantPrincipal = TenantPolicy & {
  apiKeyFingerprint: string;
};

const fingerprint = (apiKey: string): string =>
  createHash("sha256").update(apiKey).digest("hex").slice(0, 16);

export const loadTenantApiKeys = (jsonConfig: string): Map<string, TenantPrincipal> => {
  const parsedJson = JSON.parse(jsonConfig);
  const tenantMap = tenantApiKeyMapSchema.parse(parsedJson);
  const registry = new Map<string, TenantPrincipal>();

  for (const [apiKey, policy] of Object.entries(tenantMap)) {
    registry.set(apiKey, {
      ...policy,
      apiKeyFingerprint: fingerprint(apiKey)
    });
  }

  return registry;
};

export const loadTenantPolicies = (jsonConfig: string): Map<string, TenantPolicy> => {
  const parsedJson = JSON.parse(jsonConfig);
  const tenantMap = tenantPolicyMapSchema.parse(parsedJson);
  const registry = new Map<string, TenantPolicy>();

  for (const [tenantId, limits] of Object.entries(tenantMap)) {
    registry.set(tenantId, {
      tenantId,
      ...limits
    });
  }

  return registry;
};
