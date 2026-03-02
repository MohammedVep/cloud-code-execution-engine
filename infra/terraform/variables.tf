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

variable "job_queue_name" {
  description = "BullMQ queue name"
  type        = string
  default     = "code-jobs"
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

variable "analysis_max_source_chars" {
  description = "Maximum source length retained for analysis generation"
  type        = number
  default     = 8000
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
