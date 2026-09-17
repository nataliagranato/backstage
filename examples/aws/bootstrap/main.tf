# Bootstrap: cria o bucket que guarda os states e templates do aws-ops.
# Estado LOCAL de propósito (ovo-galinha): este módulo roda UMA vez, antes
# de qualquer deploy do bot. Depois, o state do bot vive no bucket criado aqui.
#
# Uso (na raiz deste diretório):
#   terraform init
#   terraform apply -var="bucket=alura-aws-ops-templates"

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "bucket" {
  type        = string
  description = "Nome global do bucket de state/templates do aws-ops"
}

resource "aws_s3_bucket" "aws_ops" {
  bucket = var.bucket
}

resource "aws_s3_bucket_versioning" "aws_ops" {
  bucket = aws_s3_bucket.aws_ops.id
  versioning_configuration {
    status = "Enabled"
  }
}

output "bucket" {
  value = aws_s3_bucket.aws_ops.bucket
}
