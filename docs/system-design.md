# System Design Document

## Requirements
### Functional
- Submit code execution jobs for multiple languages.
- Track execution states and expose polling API.
- Stream live job status updates over Server-Sent Events.
- Persist outputs, errors, execution metadata, and history.
- Provide tenant-level quotas, rate limits, and audit logs.
- Expose operational telemetry through Prometheus, Grafana, and OpenTelemetry.

### Non-Functional
- Safe execution of untrusted code.
- Burst tolerance and horizontal scalability.
- Multi-tenant isolation.
- Observability for throughput, latency, and failure rates.

## Data Model (Redis-centric)
- `job:<jobId>`: job metadata, status, request, result, attempts, analysis.
- `tenant:<tenantId>:job_history`: recent jobs sorted by recency.
- `tenant:<tenantId>:active_jobs`: active concurrency counter.
- `tenant:<tenantId>:daily_jobs:<date>`: daily usage counter.
- `tenant:<tenantId>:daily_cost:<date>`: estimated daily cost.
- `tenant:<tenantId>:rate_limit:<window>`: API request counter.
- `tenant:<tenantId>:submit_rate_limit:<window>`: submit counter.
- `audit:events`: append-only stream of security and lifecycle events.

## Tradeoffs
- Redis-only persistence keeps the stack fast and simple but limits deep analytics and long-term storage durability.
- Polling simplifies client integration but is less efficient than push/WebSocket streams.
- Task-per-execution isolation improves security but increases startup overhead.
- SSE gives real-time updates with less frontend complexity than WebSockets, but remains one-way from API to browser.
- Redis audit-derived metrics are lightweight for the portfolio workload; deep analytics should move to a durable warehouse or time-series store.

## Bottlenecks
- Worker cold starts in ECS/Fargate.
- Queue hotspot under uneven tenant bursts.
- API polling amplification from aggressive clients.

## Design Decisions
- Queue-based async execution to decouple API and runtime.
- Tenant-first controls at API edge before enqueue.
- Sandbox constraints enforced both at dispatch and runtime process level.
- Incremental AI feature (execution-aware analysis) with deterministic fallback.
- Prometheus metrics and OpenTelemetry traces expose the distributed control loop.
- Runtime profiles keep compile pipelines explicit for Java, Python, Go, JavaScript, TypeScript, C++, and C#.

## Future Plan
- Move long-term history/logs to Postgres + object storage.
- Provision RDS PostgreSQL for durable execution history and audit retention.
- Add WebSocket status stream for near-real-time updates.
- Introduce DLQ and replay tooling.
- Add tenant-aware fair scheduling and priority classes.
- Add team/workspace model with RBAC.
- Split Prometheus metrics into per-service exporters if worker-side runtime metrics outgrow API-derived snapshots.
