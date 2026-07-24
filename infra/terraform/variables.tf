variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name prefix for all resources"
  type        = string
  default     = "ccee"
}

variable "vpc_id" {
  description = "VPC ID where ECS tasks run (ignored when create_vpc=true)"
  type        = string
  default     = ""
}

variable "public_subnet_ids" {
  description = "Subnets for API tasks that retain outbound public connectivity (ignored when create_vpc=true)"
  type        = list(string)
  default     = []
}

variable "private_subnet_ids" {
  description = "Subnets for worker, runner, and ElastiCache (ignored when create_vpc=true)"
  type        = list(string)
  default     = []
}

variable "api_vpc_link_subnet_ids" {
  description = "Subnets for the API Gateway VPC Link; use AZs supported by VPC Link V2. Defaults to private_subnet_ids."
  type        = list(string)
  default     = []
}

variable "create_vpc" {
  description = "Whether to provision a dedicated VPC and subnet layout"
  type        = bool
  default     = false
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC when create_vpc=true"
  type        = string
  default     = "10.24.0.0/16"
}

variable "availability_zones" {
  description = "Availability zones to use when create_vpc=true"
  type        = list(string)
  default     = []
}

variable "public_subnet_cidrs" {
  description = "Public subnet CIDRs when create_vpc=true"
  type        = list(string)
  default     = ["10.24.10.0/24", "10.24.11.0/24"]
}

variable "private_subnet_cidrs" {
  description = "Private subnet CIDRs when create_vpc=true"
  type        = list(string)
  default     = ["10.24.20.0/24", "10.24.21.0/24"]
}

variable "api_image" {
  description = "API container image URI"
  type        = string
}

variable "worker_image" {
  description = "Worker container image URI"
  type        = string
}

variable "runner_image" {
  description = "Runner container image URI"
  type        = string
}

variable "api_cpu" {
  description = "API task CPU units"
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "API task memory in MiB"
  type        = number
  default     = 1024
}

variable "api_desired_count" {
  description = "Initial API service task count; the sleep controller owns runtime desired-count changes"
  type        = number
  default     = 1
}

variable "api_sleep_idle_timeout_seconds" {
  description = "Seconds without a wake, API Gateway request, worker task, or positive queue scale signal before the API service sleeps"
  type        = number
  default     = 900

  validation {
    condition     = var.api_sleep_idle_timeout_seconds >= 300 && var.api_sleep_idle_timeout_seconds <= 86400 && floor(var.api_sleep_idle_timeout_seconds) == var.api_sleep_idle_timeout_seconds
    error_message = "api_sleep_idle_timeout_seconds must be a whole number between 300 and 86400."
  }
}

variable "api_sleep_check_schedule_expression" {
  description = "EventBridge schedule expression for API idle checks"
  type        = string
  default     = "rate(5 minutes)"

  validation {
    condition     = can(regex("^(rate|cron)\\(", var.api_sleep_check_schedule_expression))
    error_message = "api_sleep_check_schedule_expression must be an EventBridge rate(...) or cron(...) expression."
  }
}

variable "api_wake_throttle_burst_limit" {
  description = "API Gateway burst limit for the POST /wake route"
  type        = number
  default     = 5

  validation {
    condition     = var.api_wake_throttle_burst_limit >= 1 && var.api_wake_throttle_burst_limit <= 5000 && floor(var.api_wake_throttle_burst_limit) == var.api_wake_throttle_burst_limit
    error_message = "api_wake_throttle_burst_limit must be a whole number between 1 and 5000."
  }
}

variable "api_wake_throttle_rate_limit" {
  description = "API Gateway steady-state requests per second limit for the POST /wake route"
  type        = number
  default     = 2

  validation {
    condition     = var.api_wake_throttle_rate_limit > 0 && var.api_wake_throttle_rate_limit <= 10000
    error_message = "api_wake_throttle_rate_limit must be greater than 0 and no more than 10000."
  }
}

variable "api_backend_throttle_burst_limit" {
  description = "API Gateway burst limit for proxied backend routes"
  type        = number
  default     = 100

  validation {
    condition     = var.api_backend_throttle_burst_limit >= 1 && var.api_backend_throttle_burst_limit <= 5000 && floor(var.api_backend_throttle_burst_limit) == var.api_backend_throttle_burst_limit
    error_message = "api_backend_throttle_burst_limit must be a whole number between 1 and 5000."
  }
}

variable "api_backend_throttle_rate_limit" {
  description = "API Gateway steady-state requests per second limit for proxied backend routes"
  type        = number
  default     = 50

  validation {
    condition     = var.api_backend_throttle_rate_limit > 0 && var.api_backend_throttle_rate_limit <= 10000
    error_message = "api_backend_throttle_rate_limit must be greater than 0 and no more than 10000."
  }
}

variable "api_sleep_controller_reserved_concurrency" {
  description = "Reserved Lambda concurrency for serialized wake and cache lifecycle transitions"
  type        = number
  default     = 1

  validation {
    condition     = var.api_sleep_controller_reserved_concurrency == 1
    error_message = "api_sleep_controller_reserved_concurrency must be 1 so cache lifecycle transitions are serialized."
  }
}

variable "cors_allowed_origins" {
  description = "Comma-separated browser origins allowed to call the API from the Vercel-hosted frontend"
  type        = string
  default     = "http://localhost:8080,http://localhost:3000,http://localhost:5173,https://cloudsandbox.space,https://www.cloudsandbox.space,https://*.vercel.app"
}

variable "log_retention_days" {
  description = "CloudWatch log retention for API, worker, and runner log groups"
  type        = number
  default     = 7
}

variable "runner_cpu" {
  description = "Deprecated fallback for medium runner task CPU units"
  type        = number
  default     = 512
}

variable "runner_memory" {
  description = "Deprecated fallback for medium runner task memory in MiB"
  type        = number
  default     = 1024
}

variable "runner_small_cpu" {
  description = "Small runner task CPU units"
  type        = number
  default     = 256
}

variable "runner_small_memory" {
  description = "Small runner task memory in MiB"
  type        = number
  default     = 512
}

variable "runner_medium_cpu" {
  description = "Medium runner task CPU units"
  type        = number
  default     = null
  nullable    = true
}

variable "runner_medium_memory" {
  description = "Medium runner task memory in MiB"
  type        = number
  default     = null
  nullable    = true
}

variable "runner_large_cpu" {
  description = "Large runner task CPU units"
  type        = number
  default     = 1024
}

variable "runner_large_memory" {
  description = "Large runner task memory in MiB"
  type        = number
  default     = 2048
}

variable "runner_spot_enabled" {
  description = "Whether ECS runner dispatch should prefer Fargate Spot"
  type        = bool
  default     = true
}

variable "runner_on_demand_fallback_enabled" {
  description = "Whether ECS runner dispatch should retry on regular Fargate when Spot capacity is unavailable"
  type        = bool
  default     = true
}

variable "worker_cpu" {
  description = "Worker task CPU units"
  type        = number
  default     = 512
}

variable "worker_memory" {
  description = "Worker task memory in MiB"
  type        = number
  default     = 1024
}

variable "worker_desired_count" {
  description = "Number of worker tasks"
  type        = number
  default     = 1
}

variable "worker_assign_public_ip" {
  description = "Whether worker service/task ENI gets a public IP (set false when private subnets have NAT/VPC endpoints)"
  type        = bool
  default     = false
}

variable "worker_min_capacity" {
  description = "Minimum autoscaled worker task count"
  type        = number
  default     = 0
}

variable "worker_max_capacity" {
  description = "Maximum autoscaled worker task count"
  type        = number
  default     = 10
}

variable "job_queue_name" {
  description = "BullMQ queue name"
  type        = string
  default     = "code-jobs"
}

variable "auth_mode" {
  description = "Authentication mode for API (api_key|jwt|hybrid)"
  type        = string
  default     = "api_key"
}

variable "jwt_jwks_url" {
  description = "JWKS URL for JWT verification (required when auth_mode=jwt)"
  type        = string
  default     = ""
}

variable "jwt_issuer" {
  description = "JWT issuer for token verification"
  type        = string
  default     = ""
}

variable "jwt_audience" {
  description = "Optional JWT audience check"
  type        = string
  default     = ""
}

variable "jwt_tenant_claim" {
  description = "JWT claim name containing tenant identifier"
  type        = string
  default     = "custom:tenant_id"
}

variable "jwt_subject_claim" {
  description = "JWT claim name containing subject identifier"
  type        = string
  default     = "sub"
}

variable "rate_limit_requests_per_minute" {
  description = "Per-tenant request limit in each rate-limit window"
  type        = number
  default     = 240
}

variable "rate_limit_window_seconds" {
  description = "Rate-limit window duration in seconds"
  type        = number
  default     = 60
}

variable "submit_rate_limit_per_minute" {
  description = "Per-tenant job submission limit in each rate-limit window"
  type        = number
  default     = 60
}

variable "max_source_code_bytes" {
  description = "Maximum sourceCode payload size in bytes accepted by API"
  type        = number
  default     = 100000
}

variable "max_stdin_bytes" {
  description = "Maximum stdin payload size in bytes accepted by API"
  type        = number
  default     = 100000
}

variable "job_ttl_seconds" {
  description = "Job metadata retention"
  type        = number
  default     = 86400
}

variable "job_history_max" {
  description = "Maximum number of recent jobs retained per tenant"
  type        = number
  default     = 500
}

variable "job_list_default_limit" {
  description = "Default number of history items returned by /v1/jobs"
  type        = number
  default     = 20
}

variable "job_list_max_limit" {
  description = "Maximum number of history items returned by /v1/jobs"
  type        = number
  default     = 100
}

variable "daily_quota_ttl_seconds" {
  description = "Quota daily counter TTL"
  type        = number
  default     = 172800
}

variable "worker_concurrency" {
  description = "Worker concurrency per task"
  type        = number
  default     = 4
}

variable "queue_job_attempts" {
  description = "Queue retry attempts per job for transient failures"
  type        = number
  default     = 3
}

variable "queue_retry_backoff_ms" {
  description = "Base backoff delay in milliseconds for exponential retries"
  type        = number
  default     = 1000
}

variable "queue_retry_max_delay_ms" {
  description = "Max delay (ms) for jittered exponential retries"
  type        = number
  default     = 60000
}

variable "max_stdio_bytes" {
  description = "Maximum stdout/stderr bytes captured per job"
  type        = number
  default     = 65536
}

variable "queue_depth_metric_namespace" {
  description = "CloudWatch namespace used for queue depth metrics"
  type        = string
  default     = "CCEE"
}

variable "queue_depth_metric_name" {
  description = "CloudWatch metric name used for queue depth scaling"
  type        = string
  default     = "PendingJobsCount"
}

variable "queue_depth_scale_metric_name" {
  description = "CloudWatch metric name used for scale-from-zero autoscaling signal"
  type        = string
  default     = "PendingJobsScaleSignal"
}

variable "queue_depth_publish_interval_ms" {
  description = "Worker metric publish interval in milliseconds"
  type        = number
  default     = 30000
}

variable "dlq_queue_name" {
  description = "Dead-letter queue name for exhausted retries"
  type        = string
  default     = "code-jobs-dlq"
}

variable "dlq_replay_schedule_expression" {
  description = "EventBridge schedule expression for DLQ replay task"
  type        = string
  default     = "rate(6 hours)"
}

variable "dlq_replay_offpeak_schedule_expression" {
  description = "EventBridge cron expression for off-peak DLQ replay (UTC)"
  type        = string
  default     = "cron(0 7 * * ? *)"
}

variable "enable_scheduled_dlq_replay" {
  description = "Whether EventBridge launches scheduled DLQ replay tasks; the task definition and manual admin replay path remain available when false"
  type        = bool
  default     = true
}

variable "node_options" {
  description = "Node.js runtime options for V8 tuning"
  type        = string
  default     = "--max-old-space-size=512"
}

variable "uv_threadpool_size" {
  description = "libuv thread pool size"
  type        = number
  default     = 8
}

variable "worker_queue_depth_target" {
  description = "Target queue depth per worker for target tracking autoscaling"
  type        = number
  default     = 25
}

variable "worker_scale_to_zero_cooldown_seconds" {
  description = "Cooldown (seconds) for explicit empty-queue scale-to-zero policy"
  type        = number
  default     = 120
}

variable "worker_empty_queue_evaluation_periods" {
  description = "Number of periods queue must remain empty before forcing desired count to zero"
  type        = number
  default     = 5
}

variable "worker_empty_queue_period_seconds" {
  description = "Period length (seconds) for empty queue scale-to-zero alarm"
  type        = number
  default     = 60
}

variable "worker_scale_from_zero_cooldown_seconds" {
  description = "Cooldown (seconds) for non-empty queue wake-up policy"
  type        = number
  default     = 60
}

variable "worker_nonempty_queue_evaluation_periods" {
  description = "Number of periods queue must stay non-empty before forcing desired count to 1"
  type        = number
  default     = 1
}

variable "worker_nonempty_queue_period_seconds" {
  description = "Period length (seconds) for non-empty queue wake-up alarm"
  type        = number
  default     = 60
}

variable "worker_nonempty_queue_threshold" {
  description = "Threshold for non-empty queue wake-up alarm"
  type        = number
  default     = 0
}

variable "analysis_max_source_chars" {
  description = "Maximum source length retained for analysis generation"
  type        = number
  default     = 8000
}

variable "ai_provider" {
  description = "AI provider for execution analysis (none|openai)"
  type        = string
  default     = "none"
}

variable "openai_model" {
  description = "OpenAI model used when ai_provider=openai"
  type        = string
  default     = "gpt-4.1-mini"
}

variable "ai_analysis_timeout_ms" {
  description = "Timeout in milliseconds for AI analysis requests"
  type        = number
  default     = 10000
}

variable "ai_analysis_retries" {
  description = "Number of retries for AI analysis API calls"
  type        = number
  default     = 2
}

variable "ai_analysis_retry_backoff_ms" {
  description = "Base backoff delay in milliseconds between AI analysis retries"
  type        = number
  default     = 500
}

variable "openai_api_key" {
  description = "OpenAI API key for analysis generation"
  type        = string
  default     = ""
  sensitive   = true
}

variable "otel_enabled" {
  description = "Enable OpenTelemetry trace export from the API service"
  type        = bool
  default     = false
}

variable "otel_service_name" {
  description = "OpenTelemetry service.name for the API service"
  type        = string
  default     = "ccee-api"
}

variable "worker_otel_service_name" {
  description = "OpenTelemetry service.name for the worker service"
  type        = string
  default     = "ccee-worker"
}

variable "otel_exporter_otlp_endpoint" {
  description = "OTLP HTTP trace endpoint, for example http://collector:4318/v1/traces"
  type        = string
  default     = ""
}

variable "metrics_window_seconds" {
  description = "Window used by API-derived Prometheus metrics"
  type        = number
  default     = 60
}

variable "metrics_sample_limit" {
  description = "Maximum audit stream events scanned by API-derived metrics"
  type        = number
  default     = 1000
}

variable "worker_fleet_capacity" {
  description = "Fallback worker fleet capacity used for utilization metrics when ECS describe data is unavailable"
  type        = number
  default     = 4
}

variable "enable_rds" {
  description = "Whether to provision an RDS PostgreSQL database"
  type        = bool
  default     = false
}

variable "enable_vpc_endpoints" {
  description = "Whether to provision VPC endpoints for private service access"
  type        = bool
  default     = false
}

variable "vpc_endpoint_subnet_ids" {
  description = "Subnet IDs for interface VPC endpoints (defaults to private subnets)"
  type        = list(string)
  default     = []
}

variable "vpc_endpoint_route_table_ids" {
  description = "Route table IDs for S3 gateway endpoint (optional)"
  type        = list(string)
  default     = []
}

variable "rds_db_name" {
  description = "RDS database name"
  type        = string
  default     = "ccee"
}

variable "rds_username" {
  description = "RDS master username"
  type        = string
  default     = "ccee_admin"
}

variable "rds_password" {
  description = "RDS master password"
  type        = string
  default     = ""
  sensitive   = true
}

variable "rds_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.small"
}

variable "rds_allocated_storage_gb" {
  description = "RDS allocated storage in GB"
  type        = number
  default     = 20
}

variable "rds_multi_az" {
  description = "Enable RDS Multi-AZ"
  type        = bool
  default     = false
}

variable "audit_stream_key" {
  description = "Redis stream key for audit events"
  type        = string
  default     = "audit:events"
}

variable "tenant_api_keys_json" {
  description = "JSON map of API keys to tenant quota policy"
  type        = string
  default     = "{\"dev-local-key\":{\"tenantId\":\"tenant-dev\",\"maxConcurrentJobs\":5,\"maxDailyJobs\":1000}}"
  sensitive   = true
}

variable "tenant_policies_json" {
  description = "JSON map of tenant IDs to quota policy for JWT-based auth"
  type        = string
  default     = "{}"
}

variable "admin_api_keys_json" {
  description = "JSON array of API keys allowed to access admin observability endpoints"
  type        = string
  default     = "[\"dev-local-key\"]"
  sensitive   = true
}

variable "admin_burst_max" {
  description = "Maximum burst size allowed for admin simulate burst endpoint"
  type        = number
  default     = 1000
}

variable "redis_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_engine" {
  description = "ElastiCache engine for the Redis-compatible datastore"
  type        = string
  default     = "valkey"
}

variable "redis_engine_version" {
  description = "ElastiCache Redis-compatible engine version"
  type        = string
  default     = "9.1"
}

variable "redis_parameter_group_name" {
  description = "ElastiCache parameter group for the selected Redis-compatible engine"
  type        = string
  default     = "default.valkey9"
}

variable "redis_num_cache_clusters" {
  description = "Number of Redis-compatible cache clusters (1 for dev, >=2 for failover)"
  type        = number
  default     = 1
}

variable "redis_hibernation_enabled" {
  description = "Hand cache ownership to the sleep controller, which snapshots and deletes it after all safety gates pass"
  type        = bool
  default     = false
}

variable "redis_hibernation_snapshot_retention" {
  description = "Number of available controller-owned cache snapshots to retain"
  type        = number
  default     = 3

  validation {
    condition     = var.redis_hibernation_snapshot_retention >= 2 && var.redis_hibernation_snapshot_retention <= 10 && floor(var.redis_hibernation_snapshot_retention) == var.redis_hibernation_snapshot_retention
    error_message = "redis_hibernation_snapshot_retention must be a whole number between 2 and 10."
  }
}

variable "redis_auth_token" {
  description = "Optional Redis-compatible AUTH token (set for production)"
  type        = string
  default     = null
  sensitive   = true
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
