terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

locals {
  project = var.project_name
}

# 1. VPC with public + private subnets
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"

  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${local.project}-vpc"
  }
}

# Subnets
resource "aws_subnet" "public" {
  count  = 2
  vpc_id = aws_vpc.main.id

  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 1)
  map_public_ip_on_launch = true
  availability_zone = element(data.aws_availability_zones.available.names, count.index)

  tags = {
    Name = "${local.project}-public-${count.index + 1}"
  }
}

resource "aws_subnet" "private" {
  count  = 2
  vpc_id = aws_vpc.main.id

  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  availability_zone = element(data.aws_availability_zones.available.names, count.index)

  tags = {
    Name = "${local.project}-private-${count.index + 1}"
  }
}

data "aws_availability_zones" "available" {}

# Internet Gateway
resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.project}-igw"
  }
}

# Route table for public (internet‑facing)
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = {
    Name = "${local.project}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# NAT Gateway
resource "aws_eip" "nat" {
  count = 1
  vpc   = true
}

resource "aws_nat_gateway" "nat" {
  count         = 1
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[0].id

  tags = {
    Name = "${local.project}-nat"
  }
}

# Route table for private (goes out via NAT)
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_nat_gateway.nat.id
  }

  tags = {
    Name = "${local.project}-private-rt"
  }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# 2. Security Groups
resource "aws_security_group" "lambda" {
  name        = "${local.project}-lambda-sg"
  vpc_id      = aws_vpc.main.id
  description = "Security group for Lambda"

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  tags = {
    Name = "${local.project}-lambda-sg"
  }
}

resource "aws_security_group" "rds" {
  name        = "${local.project}-rds-sg"
  vpc_id      = aws_vpc.main.id
  description = "Security group for RDS"

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.project}-rds-sg"
  }
}

# 3. RDS PostgreSQL (private)
resource "aws_db_instance" "evo_mind" {
  identifier           = "${local.project}-db"
  engine               = "postgres"
  engine_version       = "15.7"
  instance_class       = "db.t3.micro"
  allocated_storage    = 20
  storage_type         = "gp2"
  skip_final_snapshot  = true
  publicly_accessible  = false
  vpc_security_group_ids = [aws_security_group.rds.id]
  db_subnet_group_name = aws_db_subnet_group.main.name
  username             = "lambda_user"
  password             = "hardcoded_password_for_demo"  # in practice: use AWS Secrets Manager

  tags = {
    Name = "${local.project}-db"
  }
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.project}-db-subnet-group"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${local.project}-db-subnet-group"
  }
}

# 4. IAM role for Lambda (simplified)

resource "aws_iam_role" "lambda_execution" {
  name = "${local.project}-lambda-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_execution_basic" {
  role       = aws_iam_role.lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_rds" {
  role       = aws_iam_role.lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonRDSDataFullAccess"
}

resource "aws_iam_role_policy_attachment" "lambda_sqs" {
  role       = aws_iam_role.lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSQSFullAccess"
}

resource "aws_iam_role_policy_attachment" "lambda_cloudwatch" {
  role       = aws_iam_role.lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchLogsFullAccess"
}

# 5. SQS queues

resource "aws_sqs_queue" "workflow" {
  name = "SYS-SQS-Workflow"

  tags = {
    Name = "${local.project}-workflow-queue"
  }
}

resource "aws_sqs_queue" "dlq" {
  name = "SYS-SQS-Workflow-DLQ"

  tags = {
    Name = "${local.project}-workflow-dlq"
  }
}

resource "aws_sqs_queue_redrive_policy" "workflow" {
  queue_url = aws_sqs_queue.workflow.id

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_sqs_queue" "slack_results" {
  name = "SYS-SQS-SlackResults"

  tags = {
    Name = "${local.project}-slack-results-queue"
  }
}

resource "aws_sqs_queue" "schema" {
  name = "SYS-SQS-Schema"

  tags = {
    Name = "${local.project}-schema-queue"
  }
}

# 6. Lambda function (your existing ESM .js)

# Zip and upload to S3 (you can manage this separately; here we keep it minimal)

resource "aws_s3_bucket" "lambda" {
  bucket = "${local.project}-${random_id.bucket.hex}"

  tags = {
    Name = "${local.project}-lambda-bucket"
  }
}

resource "random_id" "bucket" {
  byte_length = 4
}

resource "aws_s3_object" "lambda_archive" {
  bucket = aws_s3_bucket.lambda.id
  key    = "lambda/${local.project}-lambda.zip"
  source = "lambda.zip"  # you build this from your 'lambda/' dir
}

resource "aws_lambda_function" "workflow" {
  function_name = "${local.project}-step-orchestrator"
  description   = "Orchestrates workflow steps and talks to RDS/SQS"
  filename      = aws_s3_object.lambda_archive.key
  source_code_hash = aws_s3_object.lambda_archive.etag
  handler       = "handler.lambdaHandler"
  runtime       = "nodejs20.x"
  role          = aws_iam_role.lambda_execution.arn
  timeout       = 30

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      DB_HOST     = aws_db_instance.evo_mind.address
      DB_NAME     = "evo_mind"
      DB_USER     = "lambda_user"
      DB_PASSWORD = "hardcoded_password_for_demo"  # in practice: inject from Secrets Manager
      WORKFLOW_QUEUE_URL = aws_sqs_queue.workflow.id
      SLACK_QUEUE_URL    = aws_sqs_queue.slack_results.id
    }
  }

  tags = {
    Name = "${local.project}-lambda"
  }
}

# 7. API Gateway (HTTP API)

resource "aws_apigatewayv2_api" "lambda" {
  name          = "${local.project}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "lambda" {
  name            = "prod"
  api_id          = aws_apigatewayv2_api.lambda.id
}

resource "aws_apigatewayv2_integration" "workflow" {
  api_id           = aws_apigatewayv2_api.lambda.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.workflow.invoke_arn
}

resource "aws_apigatewayv2_route" "workflow" {
  api_id    = aws_apigatewayv2_api.lambda.id
  route_key = "POST /workflow"
  target    = "integrations/${aws_apigatewayv2_integration.workflow.id}"
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.workflow.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.lambda.execution_arn}/*"
}
