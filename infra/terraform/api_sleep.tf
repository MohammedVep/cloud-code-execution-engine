locals {
  api_wake_key_hashes = distinct(concat(
    [for api_key in keys(jsondecode(var.tenant_api_keys_json)) : sha256(api_key)],
    [for api_key in jsondecode(var.admin_api_keys_json) : sha256(api_key)]
  ))

  # API Gateway HTTP APIs support exact origins and scheme-wide prefix
  # wildcards, but not the domain-middle wildcard used by the API container.
  # Keep the wake endpoint restricted to configured exact origins.
  api_wake_cors_allowed_origins = compact([
    for origin in split(",", var.cors_allowed_origins) : trimspace(origin)
    if length(regexall("\\*", origin)) == 0
  ])

  cache_snapshot_arn_prefix = "arn:${data.aws_partition.current.partition}:elasticache:${var.aws_region}:${data.aws_caller_identity.current.account_id}:snapshot:${local.name_prefix}-sleep-*"
  cache_cluster_arn_prefix  = "arn:${data.aws_partition.current.partition}:elasticache:${var.aws_region}:${data.aws_caller_identity.current.account_id}:cluster:${local.name_prefix}-redis-*"
  cache_parameter_group_arn = "arn:${data.aws_partition.current.partition}:elasticache:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parametergroup:${var.redis_parameter_group_name}"
  cache_subnet_group_arn    = "arn:${data.aws_partition.current.partition}:elasticache:${var.aws_region}:${data.aws_caller_identity.current.account_id}:subnetgroup:${aws_elasticache_subnet_group.redis.name}"
}

data "aws_partition" "current" {}

data "aws_caller_identity" "current" {}

data "archive_file" "api_sleep_controller" {
  type        = "zip"
  source_file = "${path.module}/../lambda/api_sleep_controller.py"
  output_path = "${path.module}/.terraform/api-sleep-controller.zip"
}

resource "aws_ssm_parameter" "api_last_wake" {
  name        = "/${local.name_prefix}/api-sleep/last-wake-ns"
  description = "High-resolution timestamp of the latest authenticated API wake request"
  type        = "String"
  value       = "0"

  tags = local.tags

  lifecycle {
    # Lambda owns this runtime value after Terraform creates the parameter.
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "redis_url" {
  name        = "/${local.name_prefix}/runtime/redis-url"
  description = "Current Redis-compatible URL; updated after cache restoration"
  type        = "SecureString"
  value       = local.redis_url

  tags = local.tags

  lifecycle {
    # The sleep controller replaces only the endpoint after every restore.
    ignore_changes = [value]
  }
}

resource "aws_dynamodb_table" "api_sleep_state" {
  name         = "${local.name_prefix}-api-sleep-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "controller"

  attribute {
    name = "controller"
    type = "S"
  }

  server_side_encryption {
    enabled = true
  }

  tags = local.tags
}

resource "aws_cloudwatch_log_group" "api_sleep_controller" {
  name              = "/aws/lambda/${local.name_prefix}-api-sleep-controller"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "api_wake_access" {
  name              = "/aws/apigateway/${local.name_prefix}-api-wake"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "api_sleep_controller" {
  name = "${local.name_prefix}-api-sleep-controller-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "api_sleep_controller" {
  name = "${local.name_prefix}-api-sleep-controller"
  role = aws_iam_role.api_sleep_controller.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DescribeManagedServices"
        Effect = "Allow"
        Action = ["ecs:DescribeServices"]
        Resource = [
          aws_ecs_service.api.id,
          aws_ecs_service.worker.id
        ]
      },
      {
        Sid    = "ObserveStandaloneTasks"
        Effect = "Allow"
        Action = [
          "ecs:ListTasks",
          "ecs:DescribeTasks"
        ]
        Resource = "*"
      },
      {
        Sid      = "ScaleApiService"
        Effect   = "Allow"
        Action   = ["ecs:UpdateService"]
        Resource = aws_ecs_service.api.id
      },
      {
        Sid    = "ReadAndRecordRuntimeParameters"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:PutParameter"
        ]
        Resource = [
          aws_ssm_parameter.api_last_wake.arn,
          aws_ssm_parameter.redis_url.arn
        ]
      },
      {
        Sid    = "ReadAndConditionallyWriteCacheState"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem"
        ]
        Resource = aws_dynamodb_table.api_sleep_state.arn
      },
      {
        Sid      = "ReadQueueSafetyMetric"
        Effect   = "Allow"
        Action   = ["cloudwatch:GetMetricStatistics"]
        Resource = "*"
      },
      {
        Sid    = "ObserveCacheAndSnapshots"
        Effect = "Allow"
        Action = [
          "elasticache:DescribeReplicationGroups",
          "elasticache:DescribeSnapshots"
        ]
        Resource = "*"
      },
      {
        Sid    = "SnapshotAndDeleteManagedCache"
        Effect = "Allow"
        Action = [
          "elasticache:AddTagsToResource",
          "elasticache:CreateSnapshot",
          "elasticache:DeleteReplicationGroup"
        ]
        Resource = [
          local.cache_replication_group_arn,
          local.cache_cluster_arn_prefix,
          local.cache_snapshot_arn_prefix
        ]
      },
      {
        Sid      = "PruneManagedSnapshots"
        Effect   = "Allow"
        Action   = ["elasticache:DeleteSnapshot"]
        Resource = local.cache_snapshot_arn_prefix
      },
      {
        Sid      = "RestoreManagedCache"
        Effect   = "Allow"
        Action   = ["elasticache:CreateReplicationGroup"]
        Resource = local.cache_replication_group_arn
        Condition = {
          StringEquals = {
            "aws:RequestTag/Project"   = var.project_name
            "aws:RequestTag/ManagedBy" = "ccee-sleep-controller"
          }
        }
      },
      {
        Sid    = "UseManagedCacheRestoreDependencies"
        Effect = "Allow"
        Action = ["elasticache:CreateReplicationGroup"]
        Resource = [
          local.cache_parameter_group_arn,
          local.cache_subnet_group_arn,
          local.cache_snapshot_arn_prefix,
          local.cache_cluster_arn_prefix
        ]
      },
      {
        Sid    = "ManageCacheNetworkInterfaces"
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkInterface",
          "ec2:DeleteNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets",
          "ec2:DescribeVpcs"
        ]
        Resource = "*"
      },
      {
        Sid    = "WriteControllerLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.api_sleep_controller.arn}:*"
      }
    ]
  })
}

resource "aws_lambda_function" "api_sleep_controller" {
  function_name = "${local.name_prefix}-api-sleep-controller"
  description   = "Authenticates API wake requests and scales idle API compute to zero"
  role          = aws_iam_role.api_sleep_controller.arn
  handler       = "api_sleep_controller.lambda_handler"
  runtime       = "python3.12"
  architectures = ["arm64"]

  filename         = data.archive_file.api_sleep_controller.output_path
  source_code_hash = data.archive_file.api_sleep_controller.output_base64sha256

  memory_size                    = 128
  timeout                        = 60
  reserved_concurrent_executions = var.api_sleep_controller_reserved_concurrency

  environment {
    variables = {
      API_KEY_SHA256_HASHES_JSON       = jsonencode(local.api_wake_key_hashes)
      API_SERVICE                      = aws_ecs_service.api.name
      CACHE_AT_REST_ENCRYPTION         = "true"
      CACHE_AUTO_MINOR_VERSION_UPGRADE = "true"
      CACHE_AUTOMATIC_FAILOVER         = tostring(var.redis_num_cache_clusters > 1)
      CACHE_DESCRIPTION                = "${local.name_prefix} job and audit datastore"
      CACHE_ENGINE                     = var.redis_engine
      CACHE_ENGINE_VERSION             = var.redis_engine_version
      CACHE_HIBERNATION_ENABLED        = tostring(var.redis_hibernation_enabled)
      CACHE_MULTI_AZ                   = tostring(var.redis_num_cache_clusters > 1)
      CACHE_NODE_TYPE                  = var.redis_node_type
      CACHE_NUM_CLUSTERS               = tostring(var.redis_num_cache_clusters)
      CACHE_PARAMETER_GROUP            = var.redis_parameter_group_name
      CACHE_PORT                       = "6379"
      CACHE_QUIESCENCE_SECONDS         = "60"
      CACHE_REPLICATION_GROUP_ID       = local.cache_replication_group_id
      CACHE_SECURITY_GROUP_IDS_JSON = jsonencode([
        aws_security_group.redis.id
      ])
      CACHE_SNAPSHOT_PREFIX    = "${local.name_prefix}-sleep"
      CACHE_SNAPSHOT_RETENTION = tostring(var.redis_hibernation_snapshot_retention)
      CACHE_STATE_KEY          = "cache"
      CACHE_STATE_TABLE        = aws_dynamodb_table.api_sleep_state.name
      CACHE_SUBNET_GROUP       = aws_elasticache_subnet_group.redis.name
      CACHE_TAGS_JSON          = jsonencode(local.cache_controller_tags)
      CACHE_TRANSIT_ENCRYPTION = "true"
      ECS_CLUSTER              = aws_ecs_cluster.this.name
      IDLE_TIMEOUT_SECONDS     = tostring(var.api_sleep_idle_timeout_seconds)
      LAST_WAKE_PARAMETER      = aws_ssm_parameter.api_last_wake.name
      QUEUE_METRIC_NAMESPACE   = var.queue_depth_metric_namespace
      QUEUE_METRIC_SERVICE     = local.worker_service_name
      QUEUE_NAME               = var.job_queue_name
      QUEUE_SCALE_METRIC_NAME  = var.queue_depth_scale_metric_name
      REDIS_URL_PARAMETER      = aws_ssm_parameter.redis_url.name
      WORKER_SERVICE           = aws_ecs_service.worker.name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.api_sleep_controller,
    aws_iam_role_policy.api_sleep_controller
  ]

  tags = local.tags

  lifecycle {
    precondition {
      condition     = length(local.api_wake_key_hashes) > 0
      error_message = "At least one tenant or admin API key is required to authenticate POST /wake."
    }

    precondition {
      condition     = !var.redis_hibernation_enabled || !var.enable_scheduled_dlq_replay
      error_message = "enable_scheduled_dlq_replay must be false when redis_hibernation_enabled is true."
    }

    precondition {
      condition     = length(local.api_wake_cors_allowed_origins) > 0
      error_message = "cors_allowed_origins must include at least one exact (non-wildcard) origin for POST /wake."
    }
  }
}

resource "aws_apigatewayv2_api" "api_wake" {
  name          = "${local.name_prefix}-api-wake"
  protocol_type = "HTTP"
  description   = "Public HTTP API with an authenticated wake route and private ECS proxy"

  cors_configuration {
    allow_headers = ["authorization", "content-type", "x-api-key"]
    allow_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    allow_origins = local.api_wake_cors_allowed_origins
    max_age       = 300
  }

  tags = local.tags
}

resource "aws_apigatewayv2_integration" "api_wake" {
  api_id                 = aws_apigatewayv2_api.api_wake.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  integration_uri        = aws_lambda_function.api_sleep_controller.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}

resource "aws_apigatewayv2_route" "api_wake" {
  api_id    = aws_apigatewayv2_api.api_wake.id
  route_key = "POST /wake"
  target    = "integrations/${aws_apigatewayv2_integration.api_wake.id}"
}

resource "aws_apigatewayv2_stage" "api_wake" {
  api_id      = aws_apigatewayv2_api.api_wake.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_wake_access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      path           = "$context.path"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      sourceIp       = "$context.identity.sourceIp"
      integrationErr = "$context.integrationErrorMessage"
    })
  }

  # API Gateway persists removed throttle values as zero, which rejects every
  # request on the new $default backend route. Keep a bounded, usable default
  # and apply the much tighter limit only to POST /wake below.
  default_route_settings {
    throttling_burst_limit = var.api_backend_throttle_burst_limit
    throttling_rate_limit  = var.api_backend_throttle_rate_limit
  }

  route_settings {
    route_key              = "POST /wake"
    throttling_burst_limit = var.api_wake_throttle_burst_limit
    throttling_rate_limit  = var.api_wake_throttle_rate_limit
  }

  tags = local.tags
}

resource "aws_lambda_permission" "api_gateway_wake" {
  statement_id  = "AllowApiGatewayWake"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api_sleep_controller.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api_wake.execution_arn}/*/POST/wake"
}

resource "aws_cloudwatch_event_rule" "api_sleep_check" {
  name                = "${local.name_prefix}-api-sleep-check"
  description         = "Checks whether API compute can safely scale to zero"
  schedule_expression = var.api_sleep_check_schedule_expression
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "api_sleep_check" {
  rule      = aws_cloudwatch_event_rule.api_sleep_check.name
  target_id = "api-sleep-controller"
  arn       = aws_lambda_function.api_sleep_controller.arn
  input     = jsonencode({ action = "idle_check" })

  retry_policy {
    maximum_event_age_in_seconds = 300
    maximum_retry_attempts       = 2
  }
}

resource "aws_lambda_permission" "eventbridge_sleep_check" {
  statement_id  = "AllowEventBridgeSleepCheck"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api_sleep_controller.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.api_sleep_check.arn
}
