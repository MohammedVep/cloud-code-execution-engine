output "api_url" {
  value       = "http://${aws_lb.api.dns_name}"
  description = "Public API base URL"
}

output "api_alb_dns_name" {
  value       = aws_lb.api.dns_name
  description = "API ALB DNS name"
}

output "ecs_cluster_arn" {
  value       = aws_ecs_cluster.this.arn
  description = "ECS cluster ARN"
}

output "vpc_id" {
  value       = local.vpc_id
  description = "VPC ID in use"
}

output "public_subnet_ids" {
  value       = local.public_subnet_ids
  description = "Public subnet IDs in use"
}

output "private_subnet_ids" {
  value       = local.private_subnet_ids
  description = "Private subnet IDs in use"
}

output "api_task_definition_arn" {
  value       = aws_ecs_task_definition.api.arn
  description = "API ECS task definition ARN"
}

output "worker_task_definition_arn" {
  value       = aws_ecs_task_definition.worker.arn
  description = "Worker ECS task definition ARN"
}

output "runner_task_definition_arn" {
  value       = aws_ecs_task_definition.runner.arn
  description = "Runner ECS task definition ARN"
}

output "api_service_name" {
  value       = aws_ecs_service.api.name
  description = "API ECS service name"
}

output "worker_service_name" {
  value       = aws_ecs_service.worker.name
  description = "Worker ECS service name"
}

output "redis_primary_endpoint" {
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
  description = "Redis primary endpoint address"
}

output "redis_url" {
  value       = local.redis_url
  description = "Redis connection URL for services"
  sensitive   = true
}

output "rds_endpoint" {
  value       = var.enable_rds ? aws_db_instance.postgres[0].address : null
  description = "RDS PostgreSQL endpoint address"
}

output "rds_port" {
  value       = var.enable_rds ? aws_db_instance.postgres[0].port : null
  description = "RDS PostgreSQL port"
}

output "rds_db_name" {
  value       = var.enable_rds ? aws_db_instance.postgres[0].db_name : null
  description = "RDS PostgreSQL database name"
}
