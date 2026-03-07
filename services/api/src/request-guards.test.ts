import test from "node:test";
import assert from "node:assert/strict";

import { evaluatePayloadSizeLimits } from "./request-guards.js";

test("evaluatePayloadSizeLimits allows payloads within limits", () => {
  const violation = evaluatePayloadSizeLimits({
    sourceCode: "console.log('ok')",
    stdin: "input",
    maxSourceCodeBytes: 100,
    maxStdinBytes: 100
  });

  assert.equal(violation, null);
});

test("evaluatePayloadSizeLimits rejects oversized sourceCode first", () => {
  const violation = evaluatePayloadSizeLimits({
    sourceCode: "a".repeat(101),
    stdin: "b".repeat(200),
    maxSourceCodeBytes: 100,
    maxStdinBytes: 150
  });

  assert.deepEqual(violation, {
    field: "sourceCode",
    bytes: 101,
    maxBytes: 100
  });
});

test("evaluatePayloadSizeLimits rejects oversized stdin", () => {
  const violation = evaluatePayloadSizeLimits({
    sourceCode: "a".repeat(10),
    stdin: "b".repeat(151),
    maxSourceCodeBytes: 100,
    maxStdinBytes: 150
  });

  assert.deepEqual(violation, {
    field: "stdin",
    bytes: 151,
    maxBytes: 150
  });
});
