# Security Model

## Threat Model
Users submit untrusted source code and input. The platform must prevent sandbox escape, noisy-neighbor abuse, resource exhaustion, and cross-tenant data access.

## Controls Implemented
### Identity and tenancy
- API key/JWT authentication with tenant mapping.
- Tenant isolation on all reads/writes (`404` for cross-tenant access).

### Abuse controls
- Request rate limiting per tenant.
- Separate submit burst limiting per tenant.
- Quota enforcement (`maxConcurrentJobs`, `maxDailyJobs`).
- Payload size limits for source and stdin.

### Sandbox controls
- Isolated execution runtime per job.
- Fargate tasks run on Firecracker microVMs, providing a hardware-virtualization isolation boundary.
- CPU, memory, wall-clock timeout, process count, and file-size limits.
- Non-root execution with dropped capabilities and `no-new-privileges`.
- Local mode network disabled in sandbox (`--network none`).
- Read-only filesystem patterns + bounded writable tmpfs/work dir.
- Max stdout/stderr capture to avoid log exhaustion.

### Auditability
- Append-only audit events for auth failures, rate-limit rejects, quota rejects, retries, and terminal outcomes.

## Reliability/Security Failure Handling
- Retries with exponential backoff on transient worker failures.
- Terminal failure classification (`timeout`, `infrastructure`, `user_code`, `runtime`).
- Explicit timeout representation (`timed_out`) at API layer.

## Recommended Next Hardening
- Add DLQ semantics and poison-job quarantine.
- Add suspicious pattern detection hooks before queue admission.
- Add policy-based syscall and import restrictions per language profile.
- Add WAF/edge throttling in front of API ingress.
