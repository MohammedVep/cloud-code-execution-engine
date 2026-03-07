# System Design Document

## Requirements
### Functional
- Submit code execution jobs for multiple languages.
- Track execution states and expose polling API.
- Persist outputs, errors, execution metadata, and history.
- Provide tenant-level quotas, rate limits, and audit logs.

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

## Bottlenecks
- Worker cold starts in ECS/Fargate.
- Queue hotspot under uneven tenant bursts.
- API polling amplification from aggressive clients.

## Design Decisions
- Queue-based async execution to decouple API and runtime.
- Tenant-first controls at API edge before enqueue.
- Sandbox constraints enforced both at dispatch and runtime process level.
- Incremental AI feature (execution-aware analysis) with deterministic fallback.

## Future Plan
- Move long-term history/logs to Postgres + object storage.
- Add WebSocket status stream for near-real-time updates.
- Introduce DLQ and replay tooling.
- Add tenant-aware fair scheduling and priority classes.
- Add team/workspace model with RBAC.
