# Observability

CloudSandbox exposes operational telemetry through three layers: API JSON, Prometheus metrics, and optional OpenTelemetry traces across the API and worker.

## Runtime Endpoints

- `GET /v1/runtimes`: supported languages, runtime toolchains, compile/run pipelines, and isolation summary.
- `GET /v1/observability/summary`: JSON dashboard data for queue depth, jobs per second, average runtime, failure rate, and worker utilization.
- `GET /metrics`: Prometheus text exposition format.
- `GET /v1/jobs/:jobId/events`: authenticated Server-Sent Events stream for live job status updates.

## Prometheus Metrics

- `ccee_jobs_per_second`: submitted jobs per second over `METRICS_WINDOW_SECONDS`.
- `ccee_average_runtime_ms`: average terminal job runtime over the same window.
- `ccee_failure_rate`: failed terminal jobs divided by all terminal jobs.
- `ccee_queue_depth`: pending BullMQ backlog.
- `ccee_worker_utilization`: active jobs divided by configured or observed worker capacity.
- `ccee_worker_running`, `ccee_worker_desired`, `ccee_worker_pending`: worker fleet state.

## Local Grafana

`docker-compose.yml` starts Prometheus and Grafana with provisioning enabled.

- API: `http://localhost:8080`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3000`
- Grafana login: `admin` / `admin`
- Dashboard folder: `CloudSandbox`

## OpenTelemetry

OpenTelemetry is opt-in so local development stays lightweight.

```bash
OTEL_ENABLED=true
OTEL_SERVICE_NAME=ccee-api
WORKER_OTEL_SERVICE_NAME=ccee-worker
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318/v1/traces
```

The API attaches request spans with route, status code, duration, tenant ID, subject, and CCEE trace ID attributes. The worker wraps BullMQ job processing with job ID, tenant, language, backend, attempt, result status, runtime, exit code, task ARN, and error metadata. Job events also keep the trace ID in Redis audit metadata, which ties API submission, queue processing, runner completion, and UI polling together.
