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

export type AnalysisRuntimeConfig = {
  provider: "none" | "openai";
  openAiApiKey?: string;
  model: string;
  timeoutMs: number;
  retries: number;
  retryBackoffMs: number;
};

export type AnalysisOutput = {
  analysis: ExecutionAnalysis;
  provider: "heuristic" | "openai";
  fallbackReason?: string;
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

const toConfidence = (value: unknown): "low" | "medium" | "high" => {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  return "medium";
};

const normalizeSuggestions = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 5);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const generateHeuristicExecutionAnalysis = (input: AnalysisInput): ExecutionAnalysis => {
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

const generateOpenAiExecutionAnalysis = async (
  input: AnalysisInput,
  config: { apiKey: string; model: string; timeoutMs: number }
): Promise<ExecutionAnalysis> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You analyze sandboxed code execution results. Return only JSON with keys: summary, explanation, suggestions (array of short actionable strings), confidence (low|medium|high). Keep it factual and concise."
          },
          {
            role: "user",
            content: JSON.stringify({
              status: input.status,
              request: {
                language: input.request.language,
                timeoutMs: input.request.timeoutMs,
                memoryMb: input.request.memoryMb,
                cpuMillicores: input.request.cpuMillicores,
                sourceCode: input.request.sourceCode
              },
              result: input.result,
              error: input.error
            })
          }
        ]
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`openai_http_${response.status}:${detail.slice(0, 240)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("openai_empty_response");
    }

    const decoded = JSON.parse(content) as Record<string, unknown>;
    const parsed = executionAnalysisSchema.parse({
      summary: String(decoded.summary ?? "Execution analysis"),
      explanation: String(decoded.explanation ?? "No explanation was produced."),
      suggestions: normalizeSuggestions(decoded.suggestions),
      confidence: toConfidence(decoded.confidence),
      generatedAt: nowIso()
    });

    if (parsed.suggestions.length > 0) {
      return parsed;
    }

    return executionAnalysisSchema.parse({
      ...parsed,
      suggestions: ["No concrete suggestions were generated; review stderr/stdout and rerun with targeted test input."]
    });
  } finally {
    clearTimeout(timeout);
  }
};

export const generateExecutionAnalysis = async (
  input: AnalysisInput,
  runtimeConfig: AnalysisRuntimeConfig
): Promise<AnalysisOutput> => {
  const heuristic = generateHeuristicExecutionAnalysis(input);

  if (runtimeConfig.provider !== "openai") {
    return { analysis: heuristic, provider: "heuristic", fallbackReason: "ai_provider_disabled" };
  }

  const apiKey = runtimeConfig.openAiApiKey?.trim();
  if (!apiKey) {
    return { analysis: heuristic, provider: "heuristic", fallbackReason: "missing_openai_api_key" };
  }

  let lastError: string | null = null;
  const attempts = Math.max(1, runtimeConfig.retries + 1);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const aiAnalysis = await generateOpenAiExecutionAnalysis(input, {
        apiKey,
        model: runtimeConfig.model,
        timeoutMs: runtimeConfig.timeoutMs
      });

      return { analysis: aiAnalysis, provider: "openai" };
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 180) : "openai_unknown_failure";
      if (attempt < attempts) {
        await sleep(runtimeConfig.retryBackoffMs * attempt);
      }
    }
  }

  if (lastError) {
    return {
      analysis: heuristic,
      provider: "heuristic",
      fallbackReason: lastError
    };
  }

  return {
    analysis: heuristic,
    provider: "heuristic",
    fallbackReason: "openai_unknown_failure"
  };
};
