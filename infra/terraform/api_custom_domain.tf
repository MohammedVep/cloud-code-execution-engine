variable "api_custom_domain_name" {
  description = "Optional Route 53 hostname for the API Gateway HTTP API"
  type        = string
  default     = ""
}

variable "api_custom_domain_certificate_arn" {
  description = "Regional ACM certificate ARN for api_custom_domain_name"
  type        = string
  default     = ""
}

variable "api_custom_domain_zone_id" {
  description = "Route 53 public hosted zone ID for api_custom_domain_name"
  type        = string
  default     = ""
}

locals {
  api_custom_domain_enabled = alltrue([
    var.api_custom_domain_name != "",
    var.api_custom_domain_certificate_arn != "",
    var.api_custom_domain_zone_id != ""
  ])
}

resource "aws_apigatewayv2_domain_name" "api" {
  count       = local.api_custom_domain_enabled ? 1 : 0
  domain_name = var.api_custom_domain_name

  domain_name_configuration {
    certificate_arn = var.api_custom_domain_certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  tags = local.tags
}

resource "aws_apigatewayv2_api_mapping" "api" {
  count       = local.api_custom_domain_enabled ? 1 : 0
  api_id      = aws_apigatewayv2_api.api_wake.id
  domain_name = aws_apigatewayv2_domain_name.api[0].id
  stage       = aws_apigatewayv2_stage.api_wake.id
}

resource "aws_route53_record" "api" {
  count           = local.api_custom_domain_enabled ? 1 : 0
  zone_id         = var.api_custom_domain_zone_id
  name            = var.api_custom_domain_name
  type            = "A"
  allow_overwrite = true

  alias {
    name                   = aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

output "api_custom_url" {
  value       = local.api_custom_domain_enabled ? "https://${var.api_custom_domain_name}" : null
  description = "Stable custom API URL when api_custom_domain_name is configured"
}
