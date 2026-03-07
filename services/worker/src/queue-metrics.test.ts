import test from "node:test";
import assert from "node:assert/strict";

import { getQueueDepth } from "./queue-metrics.js";

test("getQueueDepth sums waiting and active counts", () => {
  assert.equal(getQueueDepth(10, 2), 12);
});

test("getQueueDepth clamps negative values", () => {
  assert.equal(getQueueDepth(-5, 3), 3);
  assert.equal(getQueueDepth(4, -9), 4);
});
