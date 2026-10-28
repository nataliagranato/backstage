provider "aws" {
  region = "us-east-1"
}

# ponytail: state local para o exercício; em produção, adicionar backend "s3"
module "sqs" {
  source  = "terraform-aws-modules/sqs/aws"
  version = "~> 4.0"

  name = "${{ values.name }}"

  create_dlq = ${{ values.create_dlq }}

  {%- if values.create_dlq %}
  redrive_policy = {
    maxReceiveCount = 10
  }
  {%- endif %}

  tags = {
    Company    = "${{ values.company }}"
    Managed_by = "backstage"
  }
}
