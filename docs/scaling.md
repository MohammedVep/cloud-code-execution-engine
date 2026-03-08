# Scaling and Reliability

## Current Scaling Design
- Asynchronous queue (`BullMQ`) between API and workers.
- Worker concurrency controlled by `WORKER_CONCURRENCY`.
- ECS deployment supports horizontal worker replicas.
- Queue depth metrics published to CloudWatch (`CCEE/PendingJobsCount`).
- ECS Application Auto Scaling with target tracking:
  - scale out when queue depth exceeds target
  - scale in toward zero when queue drains

## Key Metrics
- Jobs submitted per minute
- Queue depth (`waiting`)
- Queue wait time (submit-to-run latency)
- Execution duration
- Timeout rate
- Failure rate by category
- Worker running/pending count

## Failure Modes and Recovery
- Worker process crash: job retried up to configured attempts.
- Runner dispatch failure: retried with exponential backoff.
- Terminal retry exhaustion: job marked failed, audit event emitted.
- Timeout: runner is hard-killed and result marked failed with `timedOut=true`.

## How to Scale to Higher Volume (10k+/day)
1. Increase worker max capacity and tune target queue depth.
2. Add queue partitioning by tenant tier (gold/silver/bronze).
3. Introduce fairness scheduling to prevent tenant starvation.
4. Add DLQ for permanently failing jobs.
5. Add pre-warmed runner pools (or task reuse) to reduce cold starts.

## Noisy Neighbor Mitigation
- Tenant quotas and submit burst limits.
- Container-level resource boundaries.
- Output truncation and request payload caps.
- Per-tenant queueing/scheduling extensions (recommended next).
