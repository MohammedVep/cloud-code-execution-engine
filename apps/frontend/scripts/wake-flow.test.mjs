import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(root, "src", "index.html"), "utf8");
const buildScript = await readFile(join(root, "scripts", "build.mjs"), "utf8");
const vercelConfig = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));

test("build injects the API Gateway base and wake URLs", () => {
  assert.match(buildScript, /process\.env\.CLOUDSANDBOX_API_BASE_URL/);
  assert.match(buildScript, /replaceAll\("%%CLOUDSANDBOX_API_BASE_URL%%"/);
  assert.match(source, /const defaultApiBase = "%%CLOUDSANDBOX_API_BASE_URL%%"/);
  assert.match(buildScript, /process\.env\.CLOUDSANDBOX_WAKE_URL/);
  assert.match(buildScript, /replaceAll\("%%CLOUDSANDBOX_WAKE_URL%%"/);
  assert.match(source, /const configuredWakeUrl = "%%CLOUDSANDBOX_WAKE_URL%%"/);
});

test("Vercel has no legacy load-balancer backend rewrites", () => {
  assert.deepEqual(vercelConfig.rewrites, [
    { source: "/admin/observability", destination: "/index.html" }
  ]);
  assert.doesNotMatch(JSON.stringify(vercelConfig), /elb\.amazonaws\.com|api-alb/);
  assert.doesNotMatch(source, /elb\.amazonaws\.com|api-alb/);
});

test("authenticated entry points share the wake-aware request path", () => {
  const expectedCalls = [
    'fetchAuthenticatedJson("/v1/admin/metrics", adminKey)',
    'fetchAuthenticatedJson("/v1/admin/simulate/burst", adminKey',
    'fetchAuthenticatedJson("/v1/admin/runbook/dlq", adminKey',
    'fetchAuthenticatedJson("/v1/quotas", apiKey)',
    'fetchAuthenticatedJson("/v1/jobs?limit=10", apiKey)',
    'fetchAuthenticatedJson("/v1/audit?limit=12", apiKey)',
    'fetchAuthenticatedJson(`/v1/jobs/${latestJobId}/analyze`, apiKey',
    'fetchAuthenticatedJson("/v1/jobs", apiKey'
  ];

  for (const expectedCall of expectedCalls) {
    assert.ok(source.includes(expectedCall), `missing wake-aware call: ${expectedCall}`);
  }

  const wakeCoordinator = source.slice(
    source.indexOf("const wakeBackend = async"),
    source.indexOf("const refreshHealth = async")
  );
  assert.match(wakeCoordinator, /fetchWithTimeout\(configuredWakeUrl/);
  assert.match(wakeCoordinator, /method: "POST"/);
  assert.match(wakeCoordinator, /"x-api-key": apiKey/);
  assert.match(wakeCoordinator, /backendWakePromise/);
  assert.match(wakeCoordinator, /WAKE_TIMEOUT_MS/);
});

test("long cache restores keep a bounded authenticated wake lease alive", () => {
  assert.match(source, /const WAKE_TIMEOUT_MS = 20 \* 60_000/);
  assert.match(source, /const WAKE_LEASE_REFRESH_MS = 45_000/);
  assert.match(source, /const WAKE_MAX_ATTEMPTS = 30/);

  const wakeCoordinator = source.slice(
    source.indexOf("const wakeBackend = async"),
    source.indexOf("const ensureBackendAwake =")
  );
  const wakeLoop = wakeCoordinator.slice(wakeCoordinator.indexOf("while (Date.now() < deadline)"));

  assert.match(wakeLoop, /wakeAttempts >= WAKE_MAX_ATTEMPTS/);
  assert.match(wakeLoop, /wakeLease = await requestWakeLease\(wakeTimeoutMs\)/);
  assert.match(wakeLoop, /nextWakeAttemptAt = Date\.now\(\) \+ WAKE_LEASE_REFRESH_MS/);
  assert.match(wakeCoordinator, /wakeResponse\.status === 429 \|\| wakeResponse\.status >= 500/);
  assert.match(wakeCoordinator, /\[401, 403\]\.includes\(wakeResponse\.status\)/);
  assert.match(wakeCoordinator, /return \{ transient: true, cachePhase: "" \}/);
});

test("wake progress exposes only a validated cache phase", () => {
  const wakeCoordinator = source.slice(
    source.indexOf("const wakeBackend = async"),
    source.indexOf("const ensureBackendAwake =")
  );

  assert.match(wakeCoordinator, /const rawCachePhase = wakePayload\?\.cachePhase/);
  assert.match(wakeCoordinator, /\^\[a-z0-9_-\]\{1,48\}\$/i);
  assert.match(wakeCoordinator, /setHealthSummary\("Waking Backend", \[phaseLine, leaseLine\]\)/);
  assert.doesNotMatch(wakeCoordinator, /JSON\.stringify\(wakePayload\)|wakePayload\?\.(?:secret|apiKey|token)/);
});

test("page initialization is silent and status refresh cannot wake", () => {
  const bootstrap = source.slice(source.indexOf("const isAdminRoute ="));
  assert.doesNotMatch(bootstrap, /setInterval\(/);
  assert.match(bootstrap, /if \(!isAdminRoute\) \{\s*initMonacoEditor\(\);\s*\}/);

  const healthRefresh = source.slice(
    source.indexOf("const refreshHealth = async"),
    source.indexOf("const toNumber =")
  );
  assert.match(healthRefresh, /checkBackendHealth\(\)/);
  assert.doesNotMatch(healthRefresh, /ensureBackendAwake|configuredWakeUrl|method: "POST"|x-api-key/);
});
