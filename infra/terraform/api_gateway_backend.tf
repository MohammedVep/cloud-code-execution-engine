resource "aws_security_group" "api_vpc_link" {
  name        = "${local.name_prefix}-api-vpc-link-sg"
  description = "API Gateway VPC Link egress to API tasks"
  vpc_id      = local.vpc_id

  tags = local.tags
}

resource "aws_security_group_rule" "api_vpc_link_to_api" {
  type                     = "egress"
  security_group_id        = aws_security_group.api_vpc_link.id
  source_security_group_id = aws_security_group.api.id
  protocol                 = "tcp"
  from_port                = 8080
  to_port                  = 8080
}

resource "aws_security_group_rule" "api_ingress_from_vpc_link" {
  type                     = "ingress"
  security_group_id        = aws_security_group.api.id
  source_security_group_id = aws_security_group.api_vpc_link.id
  protocol                 = "tcp"
  from_port                = 8080
  to_port                  = 8080
}

resource "aws_service_discovery_private_dns_namespace" "api" {
  name        = "${local.name_prefix}.internal"
  description = "Private service discovery namespace for ${local.name_prefix}"
  vpc         = local.vpc_id

  tags = local.tags
}

resource "aws_service_discovery_service" "api" {
  name        = "api"
  description = "Discoverable ${local.name_prefix} API tasks for API Gateway"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.api.id
    routing_policy = "MULTIVALUE"

    # API Gateway Cloud Map integrations require both an IP address and a
    # port. ECS populates AWS_INSTANCE_IPV4 and AWS_INSTANCE_PORT when an
    # awsvpc service uses an SRV registry plus container_name/container_port.
    dns_records {
      ttl  = 10
      type = "SRV"
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = local.tags
}

resource "aws_apigatewayv2_vpc_link" "api" {
  name               = "${local.name_prefix}-api"
  security_group_ids = [aws_security_group.api_vpc_link.id]
  subnet_ids         = length(var.api_vpc_link_subnet_ids) > 0 ? var.api_vpc_link_subnet_ids : local.private_subnet_ids

  tags = local.tags
}

resource "aws_apigatewayv2_integration" "api_backend" {
  api_id             = aws_apigatewayv2_api.api_wake.id
  description        = "Private HTTP proxy to discoverable API ECS tasks"
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = aws_service_discovery_service.api.arn

  connection_type = "VPC_LINK"
  connection_id   = aws_apigatewayv2_vpc_link.api.id

  payload_format_version = "1.0"
  timeout_milliseconds   = 30000

  # The default stage is not part of the public path, and must not be
  # prepended to the Fastify route seen by the container.
  request_parameters = {
    "overwrite:path" = "$request.path"
  }
}

resource "aws_apigatewayv2_route" "api_backend" {
  api_id    = aws_apigatewayv2_api.api_wake.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api_backend.id}"
}
