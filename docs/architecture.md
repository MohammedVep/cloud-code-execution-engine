# Architecture

## Problem Statement
Developers need a safe way to run untrusted code with fast feedback. A synchronous API model fails under bursts, has poor isolation, and cannot enforce fair usage.

## Solution Overview
The Cloud Code Execution Platform separates control-plane API operations from asynchronous execution workers. Jobs are queued, executed in isolated runtimes, and exposed through status polling endpoints.

```mermaid
flowchart TD
  A["Frontend (Browser + Monaco)"] --> B["API Service (Fastify)"]
  B --> C["Redis + BullMQ Queue"]
  C --> D["Worker Service"]
  D --> E["Sandbox Runtime (Local Docker or ECS Fargate Runner)"]
  E --> C
  B --> C
  B --> F["Audit Stream / History / Cost Counters"]
```

## Request Lifecycle
1. User submits code from the web editor.
2. API authenticates tenant and validates payload size/language/limits.
3. API enforces per-tenant request and submit burst limits.
4. API reserves quota (`maxConcurrentJobs`, `maxDailyJobs`) and enqueues the job.
5. Worker consumes the queue, marks job `running`, and dispatches sandbox execution.
6. Runner executes code with CPU/memory/process/file/time constraints.
7. Result and logs are persisted; quota/cost counters are updated.
8. Frontend polls for status changes until terminal (`succeeded`, `failed`, `timed_out`).

## Public API Surface
- `POST /executions` (alias of `POST /v1/jobs`)
- `GET /executions/:id` (alias of `GET /v1/jobs/:jobId`)
- `GET /executions/:id/logs`
- `POST /executions/:id/analyze` (AI/heuristic execution explanation)
- `GET /executions` (history alias)

## Why Queue-Based Execution
- Decouples API latency from runtime latency.
- Supports burst absorption and backpressure.
- Enables horizontal worker scaling without API saturation.
- Makes retry and dead-letter patterns feasible.
