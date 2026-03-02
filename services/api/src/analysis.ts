import {
  executionAnalysisSchema,
  nowIso,
  type ExecutionAnalysis,
  type ExecutionResult,
  type JobRequest
} from "@ccee/common";

type AnalysisInput = {
  status: string;
  request: Pick<JobRequest, "language" | "sourceCode" | "timeoutMs" | "memoryMb" | "cpuMillicores">;
  result: ExecutionResult | null;
  error: string | null;
};

const hasPattern = (value: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(value));

const nonEmptyLines = (value: string): number =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;

const baseSuggestions = (language: string): string[] => {
  if (language === "java") {
    return [
      "Keep `public class Main` as the entry point so compilation is deterministic.",
      "Wrap risky logic in try/catch and print clear error messages for failed branches."
    ];
  }

  if (language === "python") {
    return [
      "Guard execution with `if __name__ == \"__main__\":` for predictable script behavior.",
      "Add explicit exception handling to surface readable errors to users."
    ];
  }

  return [
    "Validate input before execution and fail fast on invalid data.",
    "Prefer small pure functions so behavior is easier to test and reason about."
  ];
};

export const generateExecutionAnalysis = (input: AnalysisInput): ExecutionAnalysis => {
  const suggestions = [...baseSuggestions(input.request.language)];

  if (!input.result && ["queued", "retrying", "running", "dispatched"].includes(input.status)) {
    return executionAnalysisSchema.parse({
      summary: "Execution in progress",
      explanation:
        "The job has not reached a terminal state yet. Poll status until it becomes `succeeded` or `failed` before drawing conclusions.",
      suggestions: [
        "Continue polling this job and only analyze output after completion.",
        "Use queue depth/latency metrics to tune worker concurrency under load."
      ],
      confidence: "high",
      generatedAt: nowIso()
    });
  }

  if (!input.result) {
    return executionAnalysisSchema.parse({
      summary: "Execution metadata missing",
      explanation:
        "No structured execution result was found for this job. This typically means the runner crashed or the result payload was not persisted.",
      suggestions: [
        "Inspect worker and runner logs for transport or serialization errors.",
        "Keep retries enabled so transient runner failures recover automatically."
      ],
      confidence: "low",
      generatedAt: nowIso()
    });
  }

  const stderr = input.result.stderr || "";
  const stdout = input.result.stdout || "";
  const source = input.request.sourceCode || "";

  if (input.result.status === "succeeded") {
    if (!stdout.trim()) {
      suggestions.push("Print structured output (JSON or clear labels) to make results easier to consume.");
    }

    if (nonEmptyLines(source) > 120) {
      suggestions.push("Split large scripts into smaller modules to improve readability and maintainability.");
    }

    return executionAnalysisSchema.parse({
      summary: "Execution succeeded",
      explanation:
        "The code finished within configured sandbox limits and returned a successful exit code. Captured output is available in job history.",
      suggestions: suggestions.slice(0, 5),
      confidence: "high",
      generatedAt: nowIso()
    });
  }

  if (input.result.timedOut) {
    if (hasPattern(source, [/while\s*\(\s*true\s*\)/i, /for\s*\(\s*;\s*;\s*\)/, /while\s+True\s*:/])) {
      suggestions.push("Avoid unbounded loops; add a clear exit condition or max-iteration guard.");
    }

    suggestions.push(`The current timeout is ${input.request.timeoutMs}ms; increase it only when workload characteristics justify it.`);

    return executionAnalysisSchema.parse({
      summary: "Execution timed out",
      explanation:
        "The process exceeded its wall-clock budget and was forcefully terminated by the sandbox timeout guard.",
      suggestions: suggestions.slice(0, 5),
      confidence: "high",
      generatedAt: nowIso()
    });
  }

  if (hasPattern(stderr, [/syntaxerror/i, /traceback/i, /nameerror/i, /referenceerror/i, /exception in thread/i, /javac/i])) {
    suggestions.push("Fix the syntax/runtime error shown in stderr, then rerun the same input to verify behavior.");

    return executionAnalysisSchema.parse({
      summary: "Execution failed due to code error",
      explanation:
        "The failure signal indicates a user-code issue (syntax or runtime exception) rather than an infrastructure dispatch problem.",
      suggestions: suggestions.slice(0, 5),
      confidence: "high",
      generatedAt: nowIso()
    });
  }

  if (input.error) {
    suggestions.push("Treat this as an infrastructure failure path and rely on retries/backoff for transient runner instability.");
  }

  return executionAnalysisSchema.parse({
    summary: "Execution failed",
    explanation:
      "The job terminated with a non-zero exit state. Review `stderr`, `exitCode`, and runtime limits to determine whether the failure is deterministic code behavior or an environmental issue.",
    suggestions: suggestions.slice(0, 5),
    confidence: input.error ? "medium" : "low",
    generatedAt: nowIso()
  });
};
