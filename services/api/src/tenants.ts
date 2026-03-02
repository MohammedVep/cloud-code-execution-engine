import { createHash } from "node:crypto";

import { z } from "zod";

const tenantPolicySchema = z.object({
  tenantId: z.string().min(1).max(128),
  maxConcurrentJobs: z.coerce.number().int().positive().max(1_000).default(5),
  maxDailyJobs: z.coerce.number().int().positive().max(1_000_000).default(1_000)
});

const tenantMapSchema = z.record(tenantPolicySchema);

export type TenantPrincipal = z.infer<typeof tenantPolicySchema> & {
  apiKeyFingerprint: string;
};

const fingerprint = (apiKey: string): string =>
  createHash("sha256").update(apiKey).digest("hex").slice(0, 16);

export const loadTenantApiKeys = (jsonConfig: string): Map<string, TenantPrincipal> => {
  const parsedJson = JSON.parse(jsonConfig);
  const tenantMap = tenantMapSchema.parse(parsedJson);
  const registry = new Map<string, TenantPrincipal>();

  for (const [apiKey, policy] of Object.entries(tenantMap)) {
    registry.set(apiKey, {
      ...policy,
      apiKeyFingerprint: fingerprint(apiKey)
    });
  }

  return registry;
};
