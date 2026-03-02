# Cloud Code Execution Engine (Mini Replit / Judge0 Style)

Secure, multi-tenant, asynchronous code execution platform with recruiter-facing UI and API.

## What is implemented

- `services/api`
  - Auth (`x-api-key`) + tenant isolation
  - Quotas (`maxConcurrentJobs`, `maxDailyJobs`)
  - Job submit + polling (`POST /v1/jobs`, `GET /v1/jobs/:jobId`)
  - Job history (`GET /v1/jobs`)
  - Tenant audit feed (`GET /v1/audit`)
  - Execution analysis (`POST /v1/jobs/:jobId/analyze`)
  - Recruiter UI at `/`
- `services/worker`
  - BullMQ queue consumer
  - Async dispatch to local Docker runner or ECS/Fargate runner tasks
  - Retry + exponential backoff for transient failures
- `services/runner`
  - Sandboxed execution runtime for `javascript`, `python`, `java`
  - Java path compiles + runs (`javac` then `java`)
- `packages/common`
  - Shared schemas and key conventions
- `infra/terraform`
  - ECS cluster/services, ALB, ElastiCache Redis, IAM, security groups

## Secure sandbox controls

### Enforced controls

- CPU and memory limits on job containers (`--cpus`, `--memory` locally; ECS task/container limits in cloud)
- Wall-clock timeout enforcement with hard kill (`SIGKILL`) in runner
- Process/file limits via `prlimit` (`--cpu`, `--nproc`, `--fsize`)
- Filesystem isolation:
  - container root filesystem set read-only in local runner path
  - writable area limited to tmpfs mounts (`/tmp`, `/workspace`)
  - per-job ephemeral working directory is created and deleted
- Privilege reduction:
  - run as non-root user
  - `no-new-privileges`
  - all Linux caps dropped
- Network isolation for local sandbox (`--network none`)

### Abuse prevention model

- **Tenant auth boundary:** every read/write requires valid API key and tenant match; cross-tenant job fetches return `404`.
- **Quota boundary:** atomic quota reservation blocks bursts (`maxConcurrentJobs`, `maxDailyJobs`).
- **Resource boundary:** CPU/memory/pid/file/time limits bound compute abuse and fork bombs.
- **Data boundary:** outputs are truncated (`MAX_STDIO_BYTES`) to block log-exhaustion abuse.
- **Audit boundary:** auth failures, retries, state transitions, and completions are appended to an audit stream for traceability.

## Async architecture

1. Client submits job to API.
2. API validates request, reserves tenant quota, persists job metadata/history, enqueues BullMQ job.
3. Worker consumes queue job and marks running.
4. Worker executes locally or dispatches ECS task (`EXECUTION_BACKEND=ecs`).
5. Runner persists result; API polling endpoint exposes state transitions until terminal.

## Local run

Prerequisites:

- Node.js 20+
- Docker Desktop or Colima

Example with Colima:

```bash
brew install docker docker-compose colima
colima start --cpu 2 --memory 4 --disk 20
```

Start:

```bash
cp .env.example .env
./scripts/local-up.sh
```

Open UI:

```bash
open http://localhost:8080/
```

## Local E2E (submit + poll + history + audit + analysis)

```bash
# 1) Submit
JOB_ID=$(curl -sS -X POST http://localhost:8080/v1/jobs \
  -H 'x-api-key: dev-local-key' \
  -H 'content-type: application/json' \
  -d '{
    "language": "java",
    "sourceCode": "public class Main { public static void main(String[] args) { System.out.println(\"hello\"); } }",
    "timeoutMs": 3000,
    "memoryMb": 256,
    "cpuMillicores": 256
  }' | jq -r .jobId)

# 2) Poll
curl -sS "http://localhost:8080/v1/jobs/${JOB_ID}" -H 'x-api-key: dev-local-key' | jq .

# 3) History
curl -sS "http://localhost:8080/v1/jobs?limit=10" -H 'x-api-key: dev-local-key' | jq .

# 4) Audit
curl -sS "http://localhost:8080/v1/audit?limit=10" -H 'x-api-key: dev-local-key' | jq .

# 5) Analysis
curl -sS -X POST "http://localhost:8080/v1/jobs/${JOB_ID}/analyze" -H 'x-api-key: dev-local-key' | jq .
```

Stop:

```bash
./scripts/local-down.sh
```

## API summary

- `GET /health`
- `GET /` (frontend)
- `GET /v1/quotas`
- `POST /v1/jobs`
- `GET /v1/jobs/:jobId`
- `GET /v1/jobs?limit=20`
- `GET /v1/audit?limit=20`
- `POST /v1/jobs/:jobId/analyze`

All `/v1/*` endpoints require `x-api-key`.

## Terraform production notes

The Terraform module provisions:

- ALB + API ECS service
- Worker ECS service with `EXECUTION_BACKEND=ecs`
- Runner task definition
- ElastiCache Redis (TLS)
- IAM + SG boundaries for worker/runner/API/Redis

Key required vars:

- `vpc_id`
- `public_subnet_ids`
- `private_subnet_ids`
- `api_image`
- `worker_image`
- `runner_image`

Example:

```bash
cd infra/terraform
terraform init
terraform apply \
  -var 'vpc_id=vpc-xxxx' \
  -var 'public_subnet_ids=["subnet-public-a","subnet-public-b"]' \
  -var 'private_subnet_ids=["subnet-private-a","subnet-private-b"]' \
  -var 'api_image=<account>.dkr.ecr.<region>.amazonaws.com/ccee-api:latest' \
  -var 'worker_image=<account>.dkr.ecr.<region>.amazonaws.com/ccee-worker:latest' \
  -var 'runner_image=<account>.dkr.ecr.<region>.amazonaws.com/ccee-runner:latest'
```

For production hardening:

- set `redis_auth_token`
- inject tenant API keys and secrets from a secret manager, not plain env vars
- keep API/worker in private subnets behind proper ingress controls
