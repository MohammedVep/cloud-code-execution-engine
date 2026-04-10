import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateExecutionCostUsd,
  getRunnerTierResources,
  resolveCostModelVersion,
  selectRunnerComputeTier
} from "./index.js";

test("selectRunnerComputeTier maps low, medium, and high cpu requests to fixed tiers", () => {
  assert.equal(selectRunnerComputeTier(128), "small");
  assert.equal(selectRunnerComputeTier(256), "small");
  assert.equal(selectRunnerComputeTier(257), "medium");
  assert.equal(selectRunnerComputeTier(512), "medium");
  assert.equal(selectRunnerComputeTier(513), "large");
  assert.equal(selectRunnerComputeTier(1024), "large");
});

test("estimateExecutionCostUsd uses fixed tier resources and spot discount", () => {
  const durationMs = 60 * 60 * 1000;
  const medium = getRunnerTierResources("medium");
  const onDemand = estimateExecutionCostUsd({
    durationMs,
    computeTier: "medium",
    purchaseOption: "on-demand"
  });
  const spot = estimateExecutionCostUsd({
    durationMs,
    computeTier: "medium",
    purchaseOption: "spot"
  });

  const expectedOnDemand = Number(
    ((medium.cpuUnits / 1024) * 0.04048 + (medium.memoryMb / 1024) * 0.004445).toFixed(8)
  );

  assert.equal(onDemand, expectedOnDemand);
  assert.equal(spot, Number((expectedOnDemand * 0.3).toFixed(8)));
});

test("resolveCostModelVersion upgrades only when tiered purchase metadata exists", () => {
  assert.equal(resolveCostModelVersion({}), "fargate-v1");
  assert.equal(resolveCostModelVersion({ computeTier: "small" }), "fargate-v1");
  assert.equal(resolveCostModelVersion({ computeTier: "small", purchaseOption: "spot" }), "fargate-tiered-v2");
});
