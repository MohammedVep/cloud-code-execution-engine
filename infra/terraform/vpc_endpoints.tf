locals {
  endpoint_subnet_ids      = length(var.vpc_endpoint_subnet_ids) > 0 ? var.vpc_endpoint_subnet_ids : local.private_subnet_ids
  endpoint_route_table_ids = var.vpc_endpoint_route_table_ids
}

resource "aws_security_group" "vpc_endpoints" {
  count       = var.enable_vpc_endpoints ? 1 : 0
  name        = "${local.name_prefix}-vpc-endpoints-sg"
  description = "Interface endpoint ingress from ECS tasks"
  vpc_id      = local.vpc_id

  tags = local.tags
}

resource "aws_security_group_rule" "vpc_endpoints_ingress_https" {
  count                    = var.enable_vpc_endpoints ? 1 : 0
  type                     = "ingress"
  security_group_id        = aws_security_group.vpc_endpoints[0].id
  protocol                 = "tcp"
  from_port                = 443
  to_port                  = 443
  source_security_group_id = aws_security_group.api.id
}

resource "aws_security_group_rule" "vpc_endpoints_ingress_worker" {
  count                    = var.enable_vpc_endpoints ? 1 : 0
  type                     = "ingress"
  security_group_id        = aws_security_group.vpc_endpoints[0].id
  protocol                 = "tcp"
  from_port                = 443
  to_port                  = 443
  source_security_group_id = aws_security_group.worker.id
}

resource "aws_security_group_rule" "vpc_endpoints_ingress_runner" {
  count                    = var.enable_vpc_endpoints ? 1 : 0
  type                     = "ingress"
  security_group_id        = aws_security_group.vpc_endpoints[0].id
  protocol                 = "tcp"
  from_port                = 443
  to_port                  = 443
  source_security_group_id = aws_security_group.runner.id
}

resource "aws_security_group_rule" "vpc_endpoints_egress_all" {
  count             = var.enable_vpc_endpoints ? 1 : 0
  type              = "egress"
  security_group_id = aws_security_group.vpc_endpoints[0].id
  protocol          = "-1"
  from_port         = 0
  to_port           = 0
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_vpc_endpoint" "ecr_api" {
  count               = var.enable_vpc_endpoints ? 1 : 0
  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ecr.api"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.endpoint_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = local.tags
}

resource "aws_vpc_endpoint" "ecr_dkr" {
  count               = var.enable_vpc_endpoints ? 1 : 0
  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ecr.dkr"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.endpoint_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = local.tags
}

resource "aws_vpc_endpoint" "logs" {
  count               = var.enable_vpc_endpoints ? 1 : 0
  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.logs"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.endpoint_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = local.tags
}

resource "aws_vpc_endpoint" "ecs" {
  count               = var.enable_vpc_endpoints ? 1 : 0
  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.ecs"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.endpoint_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = local.tags
}

resource "aws_vpc_endpoint" "sts" {
  count               = var.enable_vpc_endpoints ? 1 : 0
  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.sts"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.endpoint_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = local.tags
}

resource "aws_vpc_endpoint" "monitoring" {
  count               = var.enable_vpc_endpoints ? 1 : 0
  vpc_id              = local.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.monitoring"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = local.endpoint_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = local.tags
}

resource "aws_vpc_endpoint" "s3" {
  count             = var.enable_vpc_endpoints && length(local.endpoint_route_table_ids) > 0 ? 1 : 0
  vpc_id            = local.vpc_id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = local.endpoint_route_table_ids

  tags = local.tags
}
