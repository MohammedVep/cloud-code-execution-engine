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
