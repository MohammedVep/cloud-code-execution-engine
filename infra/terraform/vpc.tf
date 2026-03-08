resource "aws_security_group" "db" {
  count       = var.enable_rds ? 1 : 0
  name        = "${local.name_prefix}-db-sg"
  description = "RDS ingress from app services"
  vpc_id      = local.vpc_id

  tags = local.tags
}

resource "aws_security_group_rule" "db_from_api" {
  count                    = var.enable_rds ? 1 : 0
  type                     = "ingress"
  security_group_id        = aws_security_group.db[0].id
  source_security_group_id = aws_security_group.api.id
  protocol                 = "tcp"
  from_port                = 5432
  to_port                  = 5432
}

resource "aws_security_group_rule" "db_from_worker" {
  count                    = var.enable_rds ? 1 : 0
  type                     = "ingress"
  security_group_id        = aws_security_group.db[0].id
  source_security_group_id = aws_security_group.worker.id
  protocol                 = "tcp"
  from_port                = 5432
  to_port                  = 5432
}

resource "aws_security_group_rule" "db_from_runner" {
  count                    = var.enable_rds ? 1 : 0
  type                     = "ingress"
  security_group_id        = aws_security_group.db[0].id
  source_security_group_id = aws_security_group.runner.id
  protocol                 = "tcp"
  from_port                = 5432
  to_port                  = 5432
}

resource "aws_security_group_rule" "db_egress" {
  count             = var.enable_rds ? 1 : 0
  type              = "egress"
  security_group_id = aws_security_group.db[0].id
  protocol          = "-1"
  from_port         = 0
  to_port           = 0
  cidr_blocks       = ["0.0.0.0/0"]
}

resource "aws_db_subnet_group" "main" {
  count      = var.enable_rds ? 1 : 0
  name       = "${local.name_prefix}-db-subnets"
  subnet_ids = local.private_subnet_ids

  tags = local.tags
}

resource "aws_db_instance" "postgres" {
  count                   = var.enable_rds ? 1 : 0
  identifier              = "${local.name_prefix}-postgres"
  engine                  = "postgres"
  engine_version          = "15.5"
  instance_class          = var.rds_instance_class
  allocated_storage       = var.rds_allocated_storage_gb
  db_name                 = var.rds_db_name
  username                = var.rds_username
  password                = var.rds_password
  storage_encrypted       = true
  multi_az                = var.rds_multi_az
  publicly_accessible     = false
  db_subnet_group_name    = aws_db_subnet_group.main[0].name
  vpc_security_group_ids  = [aws_security_group.db[0].id]
  backup_retention_period = 7
  deletion_protection     = false
  skip_final_snapshot     = true
  apply_immediately       = true

  tags = local.tags
}
