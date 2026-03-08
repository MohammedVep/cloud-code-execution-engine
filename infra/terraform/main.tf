data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name_prefix         = var.project_name
  worker_service_name = "${var.project_name}-worker"
  selected_azs        = length(var.availability_zones) > 0 ? var.availability_zones : data.aws_availability_zones.available.names

  vpc_id             = var.create_vpc ? aws_vpc.main[0].id : var.vpc_id
  public_subnet_ids  = var.create_vpc ? aws_subnet.public[*].id : var.public_subnet_ids
  private_subnet_ids = var.create_vpc ? aws_subnet.private[*].id : var.private_subnet_ids

  tags = merge(
    {
      Project   = var.project_name
      ManagedBy = "terraform"
    },
    var.tags
  )

  redis_url = var.redis_auth_token == null ? "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379" : "rediss://:${urlencode(var.redis_auth_token)}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
}

resource "aws_vpc" "main" {
  count                = var.create_vpc ? 1 : 0
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = local.tags
}

resource "aws_internet_gateway" "main" {
  count  = var.create_vpc ? 1 : 0
  vpc_id = aws_vpc.main[0].id

  tags = local.tags
}

resource "aws_subnet" "public" {
  count                   = var.create_vpc ? length(var.public_subnet_cidrs) : 0
  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = local.selected_azs[count.index % length(local.selected_azs)]
  map_public_ip_on_launch = true

  tags = merge(local.tags, { Tier = "public" })
}

resource "aws_subnet" "private" {
  count                   = var.create_vpc ? length(var.private_subnet_cidrs) : 0
  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = var.private_subnet_cidrs[count.index]
  availability_zone       = local.selected_azs[count.index % length(local.selected_azs)]
  map_public_ip_on_launch = false

  tags = merge(local.tags, { Tier = "private" })
}

resource "aws_route_table" "public" {
  count  = var.create_vpc ? 1 : 0
  vpc_id = aws_vpc.main[0].id

  tags = local.tags
}

resource "aws_route" "public_internet" {
  count                  = var.create_vpc ? 1 : 0
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}

resource "aws_route_table_association" "public" {
  count          = var.create_vpc ? length(aws_subnet.public) : 0
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_eip" "nat" {
  count  = var.create_vpc ? 1 : 0
  domain = "vpc"

  tags = local.tags
}

resource "aws_nat_gateway" "main" {
  count         = var.create_vpc ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id

  tags = local.tags
}

resource "aws_route_table" "private" {
  count  = var.create_vpc ? 1 : 0
  vpc_id = aws_vpc.main[0].id

  tags = local.tags
}

resource "aws_route" "private_nat" {
  count                  = var.create_vpc ? 1 : 0
  route_table_id         = aws_route_table.private[0].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[0].id
}

resource "aws_route_table_association" "private" {
  count          = var.create_vpc ? length(aws_subnet.private) : 0
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}

resource "aws_ecs_cluster" "this" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name = aws_ecs_cluster.this.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name_prefix}/api"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name_prefix}/worker"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/ecs/${local.name_prefix}/runner"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${local.name_prefix}-redis-subnets"
  subnet_ids = local.private_subnet_ids
}

resource "aws_security_group" "api_alb" {
  name        = "${local.name_prefix}-api-alb-sg"
  description = "Public ALB security group"
  vpc_id      = local.vpc_id

  tags = local.tags
}

resource "aws_security_group_rule" "api_alb_ingress_http" {
  type              = "ingress"
  security_group_id = aws_security_group.api_alb.id
  protocol          = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group" "api" {
  name        = "${local.name_prefix}-api-sg"
  description = "API tasks"
  vpc_id      = local.vpc_id

  tags = local.tags
}

resource "aws_security_group_rule" "api_ingress_from_alb" {
  type                     = "ingress"
  security_group_id        = aws_security_group.api.id
  source_security_group_id = aws_security_group.api_alb.id
  protocol                 = "tcp"
  from_port                = 8080
  to_port                  = 8080
}

resource "aws_security_group" "worker" {
  name        = "${local.name_prefix}-worker-sg"
  description = "Worker tasks"
  vpc_id      = local.vpc_id

  tags = local.tags
}

resource "aws_security_group" "runner" {
  name        = "${local.name_prefix}-runner-sg"
  description = "Runner tasks"
  vpc_id      = local.vpc_id

  tags = local.tags
}

resource "aws_security_group" "redis" {
  name        = "${local.name_prefix}-redis-sg"
  description = "Redis ingress from app services only"
  vpc_id      = local.vpc_id

  tags = local.tags
}

resource "aws_security_group_rule" "api_to_redis" {
  type                     = "egress"
  security_group_id        = aws_security_group.api.id
  source_security_group_id = aws_security_group.redis.id
  protocol                 = "tcp"
  from_port                = 6379
  to_port                  = 6379
}

resource "aws_security_group_rule" "worker_to_redis" {
  type                     = "egress"
  security_group_id        = aws_security_group.worker.id
  source_security_group_id = aws_security_group.redis.id
  protocol                 = "tcp"
  from_port                = 6379
  to_port                  = 6379
}

resource "aws_security_group_rule" "runner_to_redis" {
  type                     = "egress"
  security_group_id        = aws_security_group.runner.id
  source_security_group_id = aws_security_group.redis.id
  protocol                 = "tcp"
  from_port                = 6379
  to_port                  = 6379
}

resource "aws_security_group_rule" "api_to_https" {
  type              = "egress"
  security_group_id = aws_security_group.api.id
  protocol          = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "worker_to_https" {
  type              = "egress"
  security_group_id = aws_security_group.worker.id
  protocol          = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "runner_to_https" {
  type              = "egress"
  security_group_id = aws_security_group.runner.id
  protocol          = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_security_group_rule" "redis_from_api" {
  type                     = "ingress"
  security_group_id        = aws_security_group.redis.id
  source_security_group_id = aws_security_group.api.id
  protocol                 = "tcp"
  from_port                = 6379
  to_port                  = 6379
}

resource "aws_security_group_rule" "redis_from_worker" {
  type                     = "ingress"
  security_group_id        = aws_security_group.redis.id
  source_security_group_id = aws_security_group.worker.id
  protocol                 = "tcp"
  from_port                = 6379
  to_port                  = 6379
}

resource "aws_security_group_rule" "redis_from_runner" {
  type                     = "ingress"
  security_group_id        = aws_security_group.redis.id
  source_security_group_id = aws_security_group.runner.id
  protocol                 = "tcp"
  from_port                = 6379
  to_port                  = 6379
}

resource "aws_security_group_rule" "alb_to_api" {
  type                     = "egress"
  security_group_id        = aws_security_group.api_alb.id
  source_security_group_id = aws_security_group.api.id
  protocol                 = "tcp"
  from_port                = 8080
  to_port                  = 8080
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${local.name_prefix}-redis"
  description                = "${local.name_prefix} job and audit datastore"
  engine                     = "redis"
  engine_version             = var.redis_engine_version
  node_type                  = var.redis_node_type
  parameter_group_name       = "default.redis7"
  num_cache_clusters         = var.redis_num_cache_clusters
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
  port                       = 6379
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.redis_auth_token
  automatic_failover_enabled = var.redis_num_cache_clusters > 1
  multi_az_enabled           = var.redis_num_cache_clusters > 1
  apply_immediately          = true

  tags = local.tags
}

resource "aws_iam_role" "task_execution" {
  name               = "${local.name_prefix}-task-exec-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "api_task" {
  name               = "${local.name_prefix}-api-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "api_metrics" {
  name = "${local.name_prefix}-api-metrics"
  role = aws_iam_role.api_task.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid      = "AllowPutQueueDepthMetric",
        Effect   = "Allow",
        Action   = ["cloudwatch:PutMetricData"],
        Resource = "*",
        Condition = {
          StringEquals = {
            "cloudwatch:namespace" = var.queue_depth_metric_namespace
          }
        }
      }
    ]
  })
}

resource "aws_iam_role" "worker_task" {
  name               = "${local.name_prefix}-worker-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "worker_metrics" {
  name = "${local.name_prefix}-worker-metrics"
  role = aws_iam_role.worker_task.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid      = "AllowPutQueueDepthMetric",
        Effect   = "Allow",
        Action   = ["cloudwatch:PutMetricData"],
        Resource = "*",
        Condition = {
          StringEquals = {
            "cloudwatch:namespace" = var.queue_depth_metric_namespace
          }
        }
      }
    ]
  })
}

resource "aws_iam_role" "runner_task" {
  name               = "${local.name_prefix}-runner-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "worker_dispatch" {
  name = "${local.name_prefix}-worker-dispatch"
  role = aws_iam_role.worker_task.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid      = "AllowRunRunnerTasks",
        Effect   = "Allow",
        Action   = ["ecs:RunTask"],
        Resource = "*"
      },
      {
        Sid      = "AllowPassRunnerRoles",
        Effect   = "Allow",
        Action   = ["iam:PassRole"],
        Resource = [aws_iam_role.task_execution.arn, aws_iam_role.runner_task.arn]
      }
    ]
  })
}

data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_lb" "api" {
  name               = "${local.name_prefix}-api-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.api_alb.id]
  subnets            = local.public_subnet_ids

  tags = local.tags
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name_prefix}-api-tg"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = local.vpc_id

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    path                = "/health"
    matcher             = "200"
  }

  tags = local.tags
}

resource "aws_lb_listener" "api_http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.api_image
      essential = true
      portMappings = [
        {
          containerPort = 8080
          hostPort      = 8080
          protocol      = "tcp"
        }
      ]

      readonlyRootFilesystem = true
      user                   = "1000:1000"

      linuxParameters = {
        initProcessEnabled = true
        capabilities = {
          drop = ["ALL"]
        }
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "api"
        }
      }

      environment = [
        { name = "API_PORT", value = "8080" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "NODE_OPTIONS", value = var.node_options },
        { name = "UV_THREADPOOL_SIZE", value = tostring(var.uv_threadpool_size) },
        { name = "REDIS_URL", value = local.redis_url },
        { name = "AUTH_MODE", value = var.auth_mode },
        { name = "JWT_JWKS_URL", value = var.jwt_jwks_url },
        { name = "JWT_ISSUER", value = var.jwt_issuer },
        { name = "JWT_AUDIENCE", value = var.jwt_audience },
        { name = "JWT_TENANT_CLAIM", value = var.jwt_tenant_claim },
        { name = "JWT_SUBJECT_CLAIM", value = var.jwt_subject_claim },
        { name = "RATE_LIMIT_REQUESTS_PER_MINUTE", value = tostring(var.rate_limit_requests_per_minute) },
        { name = "RATE_LIMIT_WINDOW_SECONDS", value = tostring(var.rate_limit_window_seconds) },
        { name = "SUBMIT_RATE_LIMIT_PER_MINUTE", value = tostring(var.submit_rate_limit_per_minute) },
        { name = "MAX_SOURCE_CODE_BYTES", value = tostring(var.max_source_code_bytes) },
        { name = "MAX_STDIN_BYTES", value = tostring(var.max_stdin_bytes) },
        { name = "JOB_QUEUE_NAME", value = var.job_queue_name },
        { name = "JOB_TTL_SECONDS", value = tostring(var.job_ttl_seconds) },
        { name = "JOB_HISTORY_MAX", value = tostring(var.job_history_max) },
        { name = "JOB_LIST_DEFAULT_LIMIT", value = tostring(var.job_list_default_limit) },
        { name = "JOB_LIST_MAX_LIMIT", value = tostring(var.job_list_max_limit) },
        { name = "AUDIT_STREAM_KEY", value = var.audit_stream_key },
        { name = "DAILY_QUOTA_TTL_SECONDS", value = tostring(var.daily_quota_ttl_seconds) },
        { name = "QUEUE_JOB_ATTEMPTS", value = tostring(var.queue_job_attempts) },
        { name = "QUEUE_RETRY_BACKOFF_MS", value = tostring(var.queue_retry_backoff_ms) },
        { name = "QUEUE_DEPTH_TARGET", value = tostring(var.worker_queue_depth_target) },
        { name = "QUEUE_DEPTH_METRIC_NAMESPACE", value = var.queue_depth_metric_namespace },
        { name = "QUEUE_DEPTH_METRIC_NAME", value = var.queue_depth_metric_name },
        { name = "QUEUE_DEPTH_PUBLISH_INTERVAL_MS", value = tostring(var.queue_depth_publish_interval_ms) },
        { name = "QUEUE_DEPTH_METRIC_SERVICE_NAME", value = local.worker_service_name },
        { name = "ANALYSIS_MAX_SOURCE_CHARS", value = tostring(var.analysis_max_source_chars) },
        { name = "AI_PROVIDER", value = var.ai_provider },
        { name = "OPENAI_MODEL", value = var.openai_model },
        { name = "AI_ANALYSIS_TIMEOUT_MS", value = tostring(var.ai_analysis_timeout_ms) },
        { name = "AI_ANALYSIS_RETRIES", value = tostring(var.ai_analysis_retries) },
        { name = "AI_ANALYSIS_RETRY_BACKOFF_MS", value = tostring(var.ai_analysis_retry_backoff_ms) },
        { name = "OPENAI_API_KEY", value = var.openai_api_key },
        { name = "TENANT_POLICIES_JSON", value = var.tenant_policies_json },
        { name = "TENANT_API_KEYS_JSON", value = var.tenant_api_keys_json }
      ]
    }
  ])

  tags = local.tags
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name_prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = var.worker_image
      essential = true

      readonlyRootFilesystem = true
      user                   = "1000:1000"

      linuxParameters = {
        initProcessEnabled = true
        capabilities = {
          drop = ["ALL"]
        }
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "worker"
        }
      }

      environment = [
        { name = "REDIS_URL", value = local.redis_url },
        { name = "JOB_QUEUE_NAME", value = var.job_queue_name },
        { name = "JOB_TTL_SECONDS", value = tostring(var.job_ttl_seconds) },
        { name = "WORKER_CONCURRENCY", value = tostring(var.worker_concurrency) },
        { name = "QUEUE_JOB_ATTEMPTS", value = tostring(var.queue_job_attempts) },
        { name = "QUEUE_RETRY_BACKOFF_MS", value = tostring(var.queue_retry_backoff_ms) },
        { name = "QUEUE_RETRY_MAX_DELAY_MS", value = tostring(var.queue_retry_max_delay_ms) },
        { name = "DLQ_QUEUE_NAME", value = var.dlq_queue_name },
        { name = "NODE_OPTIONS", value = var.node_options },
        { name = "UV_THREADPOOL_SIZE", value = tostring(var.uv_threadpool_size) },
        { name = "EXECUTION_BACKEND", value = "ecs" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "ECS_CLUSTER_ARN", value = aws_ecs_cluster.this.arn },
        { name = "ECS_TASK_DEFINITION_ARN", value = aws_ecs_task_definition.runner.arn },
        { name = "ECS_SUBNET_IDS", value = join(",", local.private_subnet_ids) },
        { name = "ECS_SECURITY_GROUP_IDS", value = aws_security_group.runner.id },
        { name = "ECS_ASSIGN_PUBLIC_IP", value = var.worker_assign_public_ip ? "ENABLED" : "DISABLED" },
        { name = "ECS_RUNNER_CONTAINER_NAME", value = "runner" },
        { name = "MAX_STDIO_BYTES", value = tostring(var.max_stdio_bytes) },
        { name = "AUDIT_STREAM_KEY", value = var.audit_stream_key },
        { name = "QUEUE_DEPTH_METRIC_NAMESPACE", value = var.queue_depth_metric_namespace },
        { name = "QUEUE_DEPTH_METRIC_NAME", value = var.queue_depth_metric_name },
        { name = "QUEUE_DEPTH_PUBLISH_INTERVAL_MS", value = tostring(var.queue_depth_publish_interval_ms) },
        { name = "QUEUE_DEPTH_METRIC_SERVICE_NAME", value = local.worker_service_name }
      ]
    }
  ])

  depends_on = [aws_iam_role_policy.worker_dispatch]
  tags       = local.tags
}

resource "aws_ecs_task_definition" "runner" {
  family                   = "${local.name_prefix}-runner"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.runner_cpu)
  memory                   = tostring(var.runner_memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.runner_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "runner"
      image     = var.runner_image
      essential = true

      readonlyRootFilesystem = false
      user                   = "1000:1000"

      linuxParameters = {
        initProcessEnabled = true
        capabilities = {
          drop = ["ALL"]
        }
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.runner.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "runner"
        }
      }

      environment = [
        { name = "RESULT_BACKEND", value = "redis" },
        { name = "AUDIT_STREAM_KEY", value = var.audit_stream_key }
      ]
    }
  ])

  tags = local.tags
}

resource "aws_ecs_service" "api" {
  name            = "${local.name_prefix}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  enable_execute_command             = true

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }

  network_configuration {
    subnets          = local.public_subnet_ids
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = true
  }

  depends_on = [aws_lb_listener.api_http]
  tags       = local.tags
}

resource "aws_ecs_service" "worker" {
  name            = local.worker_service_name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
    base              = 0
  }

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  enable_execute_command             = true

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = var.worker_assign_public_ip
  }

  depends_on = [aws_ecs_cluster_capacity_providers.this]
  tags = local.tags
}

resource "aws_ecs_task_definition" "dlq_replay" {
  family                   = "${local.name_prefix}-dlq-replay"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "dlq-replay"
      image     = var.worker_image
      essential = true
      command   = ["node", "scripts/replay-dlq.mjs"]

      readonlyRootFilesystem = true
      user                   = "1000:1000"

      linuxParameters = {
        initProcessEnabled = true
        capabilities = {
          drop = ["ALL"]
        }
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "dlq-replay"
        }
      }

      environment = [
        { name = "REDIS_URL", value = local.redis_url },
        { name = "JOB_QUEUE_NAME", value = var.job_queue_name },
        { name = "DLQ_QUEUE_NAME", value = var.dlq_queue_name },
        { name = "QUEUE_JOB_ATTEMPTS", value = tostring(var.queue_job_attempts) },
        { name = "QUEUE_RETRY_BACKOFF_MS", value = tostring(var.queue_retry_backoff_ms) },
        { name = "JOB_TTL_SECONDS", value = tostring(var.job_ttl_seconds) }
      ]
    }
  ])

  tags = local.tags
}

resource "aws_iam_role" "events_invoke_ecs" {
  name               = "${local.name_prefix}-events-ecs-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Principal = {
          Service = "events.amazonaws.com"
        },
        Action = "sts:AssumeRole"
      }
    ]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "events_invoke_ecs" {
  name = "${local.name_prefix}-events-ecs-policy"
  role = aws_iam_role.events_invoke_ecs.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect   = "Allow",
        Action   = ["ecs:RunTask"],
        Resource = [aws_ecs_task_definition.dlq_replay.arn]
      },
      {
        Effect   = "Allow",
        Action   = ["iam:PassRole"],
        Resource = [aws_iam_role.task_execution.arn, aws_iam_role.worker_task.arn]
      }
    ]
  })
}

resource "aws_cloudwatch_event_rule" "dlq_replay" {
  name                = "${local.name_prefix}-dlq-replay"
  schedule_expression = var.dlq_replay_schedule_expression
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "dlq_replay" {
  rule     = aws_cloudwatch_event_rule.dlq_replay.name
  role_arn = aws_iam_role.events_invoke_ecs.arn
  arn      = aws_ecs_cluster.this.arn

  ecs_target {
    task_count          = 1
    task_definition_arn = aws_ecs_task_definition.dlq_replay.arn
    launch_type         = "FARGATE"

    network_configuration {
      subnets          = local.private_subnet_ids
      security_groups  = [aws_security_group.worker.id]
      assign_public_ip = var.worker_assign_public_ip
    }
  }
}

resource "aws_cloudwatch_event_rule" "dlq_replay_offpeak" {
  name                = "${local.name_prefix}-dlq-replay-offpeak"
  schedule_expression = var.dlq_replay_offpeak_schedule_expression
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "dlq_replay_offpeak" {
  rule     = aws_cloudwatch_event_rule.dlq_replay_offpeak.name
  role_arn = aws_iam_role.events_invoke_ecs.arn
  arn      = aws_ecs_cluster.this.arn

  ecs_target {
    task_count          = 1
    task_definition_arn = aws_ecs_task_definition.dlq_replay.arn
    launch_type         = "FARGATE"

    network_configuration {
      subnets          = local.private_subnet_ids
      security_groups  = [aws_security_group.worker.id]
      assign_public_ip = var.worker_assign_public_ip
    }
  }
}

resource "aws_appautoscaling_target" "worker" {
  max_capacity       = var.worker_max_capacity
  min_capacity       = var.worker_min_capacity
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "worker_queue_depth" {
  name               = "${local.name_prefix}-worker-queue-depth"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = var.worker_queue_depth_target
    scale_in_cooldown  = 120
    scale_out_cooldown = 60

    customized_metric_specification {
      metric_name = var.queue_depth_metric_name
      namespace   = var.queue_depth_metric_namespace
      statistic   = "Average"
      unit        = "Count"

      dimensions {
        name  = "QueueName"
        value = var.job_queue_name
      }

      dimensions {
        name  = "Service"
        value = local.worker_service_name
      }
    }
  }
}
