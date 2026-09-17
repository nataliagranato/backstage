# Stack de exemplo da aula: Lambda hello-world + tabela DynamoDB.
# O backend/provider são gerados pelo bot (backend.tf e provider.tf);
# este arquivo contém apenas resources.

resource "aws_lambda_function" "hello" {
  function_name = "alura-hello"
  runtime       = "python3.12"
  handler       = "index.handler"
  memory_size   = 128
  timeout       = 10
  role          = aws_iam_role.hello.arn

  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
}

data "archive_file" "lambda_zip" {
  type        = "zip"
  output_path = "/tmp/alura-hello-lambda.zip"
  source {
    content  = <<PY
def handler(event, context):
    return {"statusCode": 200, "body": "hello from aws-ops"}
PY
    filename = "index.py"
  }
}

resource "aws_iam_role" "hello" {
  name = "alura-hello-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  managed_policy_arns = [
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  ]
}

resource "aws_dynamodb_table" "demo" {
  name         = "alura-demo"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"
  attribute {
    name = "id"
    type = "S"
  }
}

output "function_name" {
  value = aws_lambda_function.hello.function_name
}
