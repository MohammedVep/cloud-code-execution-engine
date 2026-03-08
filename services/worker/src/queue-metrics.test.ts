import test from "node:test";
import assert from "node:assert/strict";

import { getQueueDepth } from "./queue-metrics.js";

test("getQueueDepth returns waiting count only", () => {
  assert.equal(getQueueDepth(10), 10);
});

test("getQueueDepth clamps negative values", () => {
  assert.equal(getQueueDepth(-5), 0);
  assert.equal(getQueueDepth(4), 4);
});
