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
  description = "VPC ID where ECS tasks run"
  type        = string
}

variable "public_subnet_ids" {
  description = "Subnets for internet-facing ALB and API tasks"
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Subnets for worker, runner, and ElastiCache"
  type        = list(string)
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
  description = "API service task count"
  type        = number
  default     = 1
}

variable "runner_cpu" {
  description = "Runner task CPU units"
  type        = number
  default     = 512
}

variable "runner_memory" {
  description = "Runner task memory in MiB"
  type        = number
  default     = 1024
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
  default     = 1
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
  default     = "QueueDepth"
}

variable "queue_depth_publish_interval_ms" {
  description = "Worker metric publish interval in milliseconds"
  type        = number
  default     = 30000
}

variable "worker_scale_out_queue_depth" {
  description = "Queue depth threshold that triggers worker scale-out"
  type        = number
  default     = 10
}

variable "worker_scale_in_queue_depth" {
  description = "Queue depth threshold that triggers worker scale-in"
  type        = number
  default     = 0
}

variable "queue_depth_alarm_period_seconds" {
  description = "CloudWatch alarm period in seconds for queue depth autoscaling"
  type        = number
  default     = 60
}

variable "queue_depth_eval_periods" {
  description = "CloudWatch alarm evaluation periods for queue depth autoscaling"
  type        = number
  default     = 2
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

variable "audit_stream_key" {
  description = "Redis stream key for audit events"
  type        = string
  default     = "audit:events"
}

variable "tenant_api_keys_json" {
  description = "JSON map of API keys to tenant quota policy"
  type        = string
  default     = "{\"dev-local-key\":{\"tenantId\":\"tenant-dev\",\"maxConcurrentJobs\":5,\"maxDailyJobs\":1000}}"
}

variable "tenant_policies_json" {
  description = "JSON map of tenant IDs to quota policy for JWT-based auth"
  type        = string
  default     = "{}"
}

variable "redis_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_engine_version" {
  description = "ElastiCache Redis engine version"
  type        = string
  default     = "7.1"
}

variable "redis_num_cache_clusters" {
  description = "Number of Redis cache clusters (1 for dev, >=2 for failover)"
  type        = number
  default     = 1
}

variable "redis_auth_token" {
  description = "Optional Redis AUTH token (set for production)"
  type        = string
  default     = null
  sensitive   = true
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
