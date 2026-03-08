# Scaling and Reliability

## Current Scaling Design
- Asynchronous queue (`BullMQ`) between API and workers.
- Worker concurrency controlled by `WORKER_CONCURRENCY`.
- ECS deployment supports horizontal worker replicas on Fargate Spot.
- Queue depth metrics published to CloudWatch (`CCEE/PendingJobsCount`).
- ECS Application Auto Scaling with target tracking:
  - scale out when queue depth exceeds target
  - scale in toward zero when queue drains
- API publishes queue depth metrics so scale-from-zero can occur even with zero workers.
- Explicit empty-queue safety policy:
  - CloudWatch alarm on `CCEE/PendingJobsScaleSignal <= 0`
  - Step scaling policy forces exact desired count `0` after sustained empty periods.
- Explicit wake-up safety policy:
  - CloudWatch alarm on `CCEE/PendingJobsScaleSignal > 0`
  - Step scaling policy forces exact desired count `1` so scale-from-zero recovers quickly.

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
- Runner dispatch failure: retried with jittered exponential backoff.
- Terminal retry exhaustion: job marked failed, audit event emitted, job copied into DLQ.
- Timeout: runner is hard-killed and result marked failed with `timedOut=true`.

## DLQ Replay

Use the recovery script to requeue DLQ payloads after incident resolution:

```bash
REDIS_URL=rediss://... npm run queue:recover
```

Optional env vars:
- `DLQ_QUEUE_NAME` (default `code-jobs-dlq`)
- `JOB_QUEUE_NAME` (default `code-jobs`)
- `QUEUE_JOB_ATTEMPTS` (default `3`)
- `QUEUE_RETRY_BACKOFF_MS` (default `1000`)
- `JOB_TTL_SECONDS` (default `86400`)
- `DLQ_BATCH_SIZE` (default `50`)
- `DRY_RUN=true` (no writes)

## Scheduled Self-Healing (EventBridge)

Terraform provisions an EventBridge schedule that runs a short-lived Fargate task with the replay command on a cadence (`dlq_replay_schedule_expression`, default `rate(6 hours)`).

## How to Scale to Higher Volume (10k+/day)
1. Increase worker max capacity and tune target queue depth.
2. Add queue partitioning by tenant tier (gold/silver/bronze).
3. Introduce fairness scheduling to prevent tenant starvation.
4. Add DLQ consumers for automated replay and human triage.
5. Add pre-warmed runner pools (or task reuse) to reduce cold starts.

## Noisy Neighbor Mitigation
- Tenant quotas and submit burst limits.
- Container-level resource boundaries.
- Output truncation and request payload caps.
- Per-tenant queueing/scheduling extensions (recommended next).
