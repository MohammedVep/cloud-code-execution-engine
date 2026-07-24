# Sleep and Cache Hibernation Runbook

CloudSandbox keeps its static frontend available while ECS API compute and the
node-based ElastiCache/Valkey replication group can be absent. An authenticated
backend action renews a wake lease, restores the cache from a protected manual
snapshot when necessary, publishes the new endpoint, and only then starts the
API task.

This is not whole-account suspension. API Gateway, Lambda, EventBridge, Cloud
Map, the VPC Link, security groups, subnets, snapshot storage, CloudWatch log
storage, ECR, Route 53, the small on-demand controller state table, and optional
RDS resources remain provisioned. NAT gateways, public IPv4 addresses, and
interface VPC endpoints also remain billable whenever their corresponding
Terraform options are enabled.

## Wake path

1. Static public and admin pages load without contacting AWS.
2. An authenticated action sends `POST /wake` with its `x-api-key`. The Lambda
   compares only SHA-256 digests derived from configured tenant/admin keys.
3. Lambda must durably update the SSM wake lease before it accepts the wake.
4. If the cache is absent, Lambda adopts the newest **AVAILABLE** manual
   snapshot whose name begins with the controller prefix and calls
   `CreateReplicationGroup` with that snapshot. It never creates an empty cache.
5. While ElastiCache reports `creating`, `modifying`, `snapshotting`, or
   `deleting`, the API remains at desired count zero and `/wake` returns `202`
   with a non-secret `cachePhase`.
6. After ElastiCache reports `available`, Lambda replaces only the hostname in
   the encrypted Redis URL SSM parameter and reads it back for verification.
7. API, worker, runner, and DLQ task definitions receive `REDIS_URL` as an ECS
   execution-role SSM secret. Only after the new value is verified does Lambda
   set the API desired count to one.
8. The browser polls `/health` for up to 20 minutes and renews authenticated
   `POST /wake` every 45 seconds, with no more than 30 wake attempts. It retries
   network errors, `429`, and `5xx`, but fails immediately on `401`/`403`.
   `cachePhase` is shown in the status UI; credentials and Redis details are not.
9. Once healthy, the original user action is sent exactly once. Non-idempotent
   job/admin requests are never automatically replayed.

The durable controller phases are:

`ACTIVE → QUIESCING → SNAPSHOTTING → SNAPSHOT_READY → DELETING → SLEEPING`

A wake follows:

`SLEEPING/DELETING → RESTORING → API_STARTING → ACTIVE`

Revision-conditional writes to a one-item, `PAY_PER_REQUEST` DynamoDB table and
Lambda reserved concurrency of one fence phase changes. A stale invocation
cannot authorize an external mutation after another invocation changes state.

## Sleep path and data-safety gates

EventBridge invokes the controller every five minutes. Raw public API Gateway traffic
is deliberately not a sleep lease: only an authenticated `POST /wake` renews the
lease, so scanners and failed requests cannot keep paid compute awake.

Before API scale-down, before snapshot creation, and again before cache deletion,
the controller requires all of these observations to succeed:

- the authenticated SSM wake lease is older than the configured idle window and
  has not changed;
- API and worker desired, running, and pending counts are zero (the API is first
  scaled to zero, then checked on a later invocation);
- the queue safety metric has at least one datapoint and its maximum is zero;
- paginated ECS task inspection finds no runner, DLQ, or other standalone task;
- ECS tasks transitioning through provisioning, pending, activating,
  deactivating, or stopping are treated as active;
- the cache and the protected snapshot are in the exact phase required for the
  next action.

After all gates first become clear, Lambda persists a quiescence timestamp. It
requires a second clear observation at least 60 seconds later before taking a
snapshot. For this cluster-mode-disabled replication group, the snapshot API
must use the unique member whose `CurrentRole` is `primary` as
`CacheClusterId`; zero or multiple primaries fail closed.

That timestamp is also the durable zero-queue proof. CloudWatch custom metrics
naturally expire after the API and worker have been stopped long enough. During
`SNAPSHOTTING`, `SNAPSHOT_READY`, and `DELETING`, a missing queue datapoint is
accepted only when this proof exists. A positive datapoint still invalidates the
snapshot, and every wake, API/worker, and standalone-task gate is still checked.
The proof is cleared on activity, wake, error, and completion.

Snapshot and deletion happen on separate scheduled invocations. ElastiCache
must report the manual snapshot `available`, then every gate is checked again,
before `DeleteReplicationGroup` is called without a final snapshot. If worker,
queue, wake, API, or task activity appears after snapshotting starts, the
protected pointer is invalidated and a fresh two-pass quiescence plus snapshot
is required. Missing metrics before a zero-queue proof, pagination/describe
failures, ambiguous cache topology, and all other AWS observation errors delay
sleep.

The controller retains the newest configured number of its own available
snapshots, never deletes a foreign-prefix or non-available snapshot, and always
protects the snapshot referenced by durable state.
Controller ownership requires the exact generated name shape
`<effective-prefix>-YYYYMMDDHHMMSS-NNNNNN`. Descriptive migration and operator
snapshots such as `<prefix>-migration-*` are excluded from discovery and pruning.

## Terraform ownership and one-time migration

Terraform and Lambda must never simultaneously own the replication group. With
`redis_hibernation_enabled = false`, Terraform manages
`aws_elasticache_replication_group.redis[0]`. With it set to `true`, the resource
count is zero and the controller is the sole owner of the stable replication
group ID. Terraform continues to own its subnet group, security group, encrypted
runtime URL parameter, controller state table, Lambda, and IAM.

The repository intentionally defaults production to phase A (`false`). Do not
flip the flag with the cache still in Terraform state: that would plan a real
cache deletion. Use this two-phase handoff, during a quiet maintenance window:

1. Deploy phase A with `redis_hibernation_enabled = false`. Verify all ECS task
   definitions read `REDIS_URL` from SSM and verify authenticated wake/health.
2. Resolve exactly one primary member from `DescribeReplicationGroups`, create a
   manual snapshot named `<name-prefix>-sleep-...` using **`CacheClusterId`**, and
   wait until its status is `available`.
3. Back up remote Terraform state with `terraform state pull`.
   Confirm the configured S3 backend has versioning enabled and record the
   object version created before the handoff.
4. Preview, then remove, only the live cache address from Terraform state with
   `terraform state rm -dry-run` followed by `terraform state rm`. This is a
   metadata operation; do not use `terraform
   destroy`, `terraform apply -destroy`, or a resource-replacement command.
5. Set `redis_hibernation_enabled = true` and
   `enable_scheduled_dlq_replay = false`.
6. Produce a saved plan and verify it contains no ElastiCache replication-group
   create, update, replace, or delete. Apply only after that check passes.
7. Exercise one wake and one complete sleep cycle. Confirm the URL parameter is
   updated before ECS starts and the API, worker, runner, and DLQ definitions can
   launch with the SSM value.

Example discovery and recovery-snapshot commands (review every resolved value):

```bash
TF_DIR=infra/terraform
RG_ID=ccee-redis
SNAPSHOT_NAME="ccee-sleep-migration-$(date -u +%Y%m%d%H%M%S)"

aws elasticache describe-replication-groups \
  --replication-group-id "$RG_ID" \
  --query 'ReplicationGroups[0].NodeGroups[].NodeGroupMembers[?CurrentRole==`primary`].CacheClusterId' \
  --output text

# Continue only when the preceding command printed exactly one ID.
PRIMARY_CLUSTER_ID=ccee-redis-001
aws elasticache create-snapshot \
  --cache-cluster-id "$PRIMARY_CLUSTER_ID" \
  --snapshot-name "$SNAPSHOT_NAME"
until [ "$(aws elasticache describe-snapshots \
  --snapshot-name "$SNAPSHOT_NAME" \
  --query 'Snapshots[0].SnapshotStatus' \
  --output text)" = "available" ]; do sleep 30; done

terraform -chdir="$TF_DIR" state pull > "terraform-state-before-cache-handoff.json"
terraform -chdir="$TF_DIR" state list
# Use the exact address printed above; it is normally the indexed address below.
terraform -chdir="$TF_DIR" state rm -dry-run 'aws_elasticache_replication_group.redis[0]'
terraform -chdir="$TF_DIR" state rm 'aws_elasticache_replication_group.redis[0]'

terraform -chdir="$TF_DIR" plan \
  -var-file=terraform.prod.tfvars \
  -out=cache-hibernation.tfplan
terraform -chdir="$TF_DIR" show cache-hibernation.tfplan
```

The saved state backup contains sensitive values; store it securely and delete
the local copy according to the normal state-handling policy. If the state
address is not exactly the indexed address shown, stop and use the address from
`terraform state list`. After handoff, never import a controller-created group
while hibernation is enabled. Plans remain stable whether the cache is running
or sleeping because the replication group is intentionally outside Terraform.

To return ownership to Terraform, first wake the cache and verify it is
`available`, set the flag to `false`, import the live group into
`aws_elasticache_replication_group.redis[0]`, review a no-replacement plan, and
only then apply. Never switch the flag off while the cache is absent.
`redis_hibernation_enabled = false` is therefore a migration/ownership toggle,
not an ordinary operational wake switch: using it while the group is absent can
plan an empty replacement cache.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `api_sleep_idle_timeout_seconds` | `900` | Minimum age of the authenticated wake lease |
| `api_sleep_check_schedule_expression` | `rate(5 minutes)` | Controller cadence |
| `api_sleep_controller_reserved_concurrency` | `1` | Secondary single-writer fence |
| `redis_hibernation_enabled` | `false` | Transfers replication-group ownership to the controller |
| `redis_hibernation_snapshot_retention` | `3` | Available controller-prefix snapshots retained |
| `enable_scheduled_dlq_replay` | environment-specific | Must be `false` with cache hibernation |

The hibernation precondition rejects scheduled DLQ replay because a timer-driven
task could need Redis without a visitor wake. Manual authenticated replay remains
available after wake.

Important outputs include `api_url`, `api_wake_url`,
`api_sleep_last_wake_parameter_name`, `api_sleep_state_table_name`,
`redis_url_parameter_name`, and `api_sleep_controller_function_name`.

## Verification

```bash
TF_DIR=infra/terraform
CLUSTER_ARN=$(terraform -chdir="$TF_DIR" output -raw ecs_cluster_arn)
API_SERVICE=$(terraform -chdir="$TF_DIR" output -raw api_service_name)
WORKER_SERVICE=$(terraform -chdir="$TF_DIR" output -raw worker_service_name)
WAKE_URL=$(terraform -chdir="$TF_DIR" output -raw api_wake_url)
API_URL=$(terraform -chdir="$TF_DIR" output -raw api_url)

aws ecs describe-services \
  --cluster "$CLUSTER_ARN" \
  --services "$API_SERVICE" "$WORKER_SERVICE" \
  --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount}' \
  --output table

# Invalid credentials must not change ECS or cache state.
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST -H 'x-api-key: definitely-invalid' "$WAKE_URL"

: "${CCEE_API_KEY:?Set CCEE_API_KEY first}"
curl -fsS -X POST -H "x-api-key: $CCEE_API_KEY" "$WAKE_URL"
until curl -fsS "$API_URL/health" >/dev/null; do sleep 10; done

aws elasticache describe-replication-groups \
  --replication-group-id ccee-redis \
  --query 'ReplicationGroups[0].{status:Status,endpoint:NodeGroups[0].PrimaryEndpoint.Address}'
```

Opening a static frontend route by itself must produce no `/wake`, `/health`, or
`/v1/*` request. During a cold restore, repeated `/wake` responses should move
through `RESTORING`, `API_STARTING`, and `ACTIVE`. After the idle and quiescence
windows, ECS counts should be zero, the replication group should be absent, and
the protected manual snapshot should remain `available`.
