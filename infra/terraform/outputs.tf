output "api_url" {
  value       = aws_apigatewayv2_api.api_wake.api_endpoint
  description = "Public API Gateway base URL; backend routes use a private VPC Link integration"
}

output "api_wake_url" {
  value       = "${aws_apigatewayv2_api.api_wake.api_endpoint}/wake"
  description = "Authenticated serverless wake URL; send POST with the x-api-key header"
}

output "api_sleep_last_wake_parameter_name" {
  value       = aws_ssm_parameter.api_last_wake.name
  description = "SSM parameter storing the latest authenticated API wake timestamp"
}

output "api_sleep_controller_function_name" {
  value       = aws_lambda_function.api_sleep_controller.function_name
  description = "Lambda function handling API wake requests and idle checks"
}

output "api_gateway_id" {
  value       = aws_apigatewayv2_api.api_wake.id
  description = "Unified HTTP API identifier for wake and private backend routes"
}

output "api_sleep_state_table_name" {
  value       = aws_dynamodb_table.api_sleep_state.name
  description = "PAY_PER_REQUEST DynamoDB table containing the cache controller's revisioned state"
}

output "api_vpc_link_id" {
  value       = aws_apigatewayv2_vpc_link.api.id
  description = "API Gateway VPC Link identifier"
}

output "api_service_discovery_namespace_name" {
  value       = aws_service_discovery_private_dns_namespace.api.name
  description = "Private Cloud Map namespace containing the API service"
}

output "api_service_discovery_service_id" {
  value       = aws_service_discovery_service.api.id
  description = "Cloud Map service identifier for verifying registered API task IP and port attributes"
}

output "api_service_discovery_service_arn" {
  value       = aws_service_discovery_service.api.arn
  description = "Cloud Map service ARN used by the API Gateway private integration"
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
  value       = aws_ecs_task_definition.runner["medium"].arn
  description = "Medium runner ECS task definition ARN"
}

output "runner_task_definition_arns" {
  value = {
    small  = aws_ecs_task_definition.runner["small"].arn
    medium = aws_ecs_task_definition.runner["medium"].arn
    large  = aws_ecs_task_definition.runner["large"].arn
  }
  description = "Runner ECS task definition ARNs by compute tier"
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
  value       = var.redis_hibernation_enabled ? null : aws_elasticache_replication_group.redis[0].primary_endpoint_address
  description = "Terraform-managed Redis primary endpoint, or null when the sleep controller owns the cache"
}

output "redis_url" {
  value       = var.redis_hibernation_enabled ? null : local.redis_url
  description = "Terraform-managed Redis connection URL, or null when the runtime URL is held in SSM"
  sensitive   = true
}

output "redis_url_parameter_name" {
  value       = aws_ssm_parameter.redis_url.name
  description = "SSM SecureString parameter containing the current controller-managed Redis URL"
}

output "redis_url_parameter_arn" {
  value       = aws_ssm_parameter.redis_url.arn
  description = "ARN of the SSM SecureString parameter containing the current Redis URL"
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
