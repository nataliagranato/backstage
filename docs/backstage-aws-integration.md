# Integração Backstage ↔ AWS

Guia elaborado em 2026-09-14 com base na pesquisa do repositório oficial [awslabs/backstage-plugins-for-aws](https://github.com/awslabs/backstage-plugins-for-aws) e na documentação do Backstage.

---

## O que esta integração oferece

| Área | Capacidade |
|---|---|
| **Catálogo** | Descobrir recursos AWS (ECS, Lambda, S3, EKS…) e contas de organização via AWS Organizations |
| **Cost Insights** | Visualizar custos de AWS por serviço/time diretamente no Backstage |
| **Security Hub** | Exibir findings de segurança por entidade |
| **Scaffolder** | Ações para criar repos, publicar em CodePipeline, Proton, etc. |
| **Auth** | Autenticação via AWS ALB (Application Load Balancer) |

---

## 1. Repositório principal de plugins

O repositório oficial mantido pelo time da AWS Labs é:

```
https://github.com/awslabs/backstage-plugins-for-aws
```

Ele é organizado em pacotes independentes instaláveis separadamente:

| Pacote | Função |
|---|---|
| `@aws/plugin-amazon-ecs-for-backstage` | Visualizar serviços ECS |
| `@aws/plugin-aws-codepipeline-for-backstage` | Pipelines do CodePipeline |
| `@aws/plugin-amazon-ecr-for-backstage` | Imagens do ECR |
| `@aws/plugin-aws-lambda-for-backstage` | Funções Lambda |
| `@aws/plugin-cost-insights-for-backstage` | Cost Insights para AWS |
| `plugin-catalog-backend-module-aws` | Ingerir contas AWS como `Resource` no catálogo |

---

## 2. Credenciais e IAM

### Abordagem recomendada (sem credenciais hardcoded)

Os plugins usam a **AWS SDK default credential chain**, ou seja, respeitam automaticamente:

1. Variáveis de ambiente (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
2. `~/.aws/credentials` (perfil local)
3. IAM Instance Profile (EC2)
4. IAM Role for Service Account — **IRSA** (EKS) — recomendado para produção
5. ECS Task Role

### Permissões mínimas necessárias

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["tag:GetResources"],
      "Resource": "*"
    }
  ]
}
```

> Cada plugin adicional exige permissões específicas (ex: `ecs:Describe*` para o plugin ECS, `lambda:List*` para o Lambda, etc.)

### Para desenvolvimento local (via `.env`)

Adicione ao `.env` do projeto (já carregado pelo `dotenv-cli`):

```bash
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
```

---

## 3. Configuração em `app-config.yaml`

### Integração base (credenciais via SDK chain)

Nenhuma configuração extra é necessária se o ambiente já possui credenciais configuradas (perfil local, IRSA, ECS Task Role).

### Configuração explícita com múltiplas contas

Use `@backstage/integration-aws-node` para definir papéis cross-account:

```yaml
aws:
  mainAccount:
    accessKeyId: ${AWS_ACCESS_KEY_ID}
    secretAccessKey: ${AWS_SECRET_ACCESS_KEY}

  accounts:
    - accountId: '123456789012'
      roleName: 'BackstageRole'
      region: 'us-east-1'
    - accountId: '987654321098'
      roleName: 'BackstageRole'
      region: 'sa-east-1'
```

---

## 4. Instalar plugins individualmente

### Exemplo: Plugin Amazon ECS

**Backend:**
```bash
yarn workspace backend add @aws/plugin-amazon-ecs-for-backstage-backend
```

Registrar em `packages/backend/src/index.ts`:
```ts
backend.add(import('@aws/plugin-amazon-ecs-for-backstage-backend'));
```

**Frontend:**
```bash
yarn workspace app add @aws/plugin-amazon-ecs-for-backstage
```

Adicionar ao `EntityPage` em `packages/app/src/components/catalog/EntityPage.tsx`:
```tsx
import { EntityAmazonEcsServicesContent } from '@aws/plugin-amazon-ecs-for-backstage';

// Dentro do serviceEntityPage:
<EntityLayout.Route path="/ecs" title="ECS">
  <EntityAmazonEcsServicesContent />
</EntityLayout.Route>
```

Anotar a entidade no `catalog-info.yaml`:
```yaml
metadata:
  annotations:
    aws.amazon.com/ecs-service-arn: 'arn:aws:ecs:us-east-1:123456789012:service/cluster/service'
```

---

## 5. Ingerir contas AWS Organizations no Catálogo

```bash
yarn workspace backend add @backstage/plugin-catalog-backend-module-aws
```

Registre em `packages/backend/src/index.ts`:
```ts
backend.add(import('@backstage/plugin-catalog-backend-module-aws'));
```

Configure em `app-config.yaml`:
```yaml
catalog:
  providers:
    awsOrganizations:
      orgProvider:
        roleArn: 'arn:aws:iam::MANAGEMENT_ACCOUNT:role/BackstageOrgRole'
        region: us-east-1
        schedule:
          frequency: { hours: 1 }
          timeout: { minutes: 5 }
```

---

## 6. Autenticação via AWS ALB

Se o Backstage for exposto por um Application Load Balancer com autenticação OIDC/Cognito:

```bash
yarn workspace backend add @backstage/plugin-auth-backend-module-aws-alb-provider
```

```ts
backend.add(import('@backstage/plugin-auth-backend-module-aws-alb-provider'));
```

```yaml
auth:
  providers:
    awsAlb:
      region: us-east-1
      issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXX'
```

---

## 7. Anotações suportadas por plugin

| Plugin | Anotação no `catalog-info.yaml` |
|---|---|
| ECS | `aws.amazon.com/ecs-service-arn` |
| Lambda | `aws.amazon.com/lambda-function-arn` |
| CodePipeline | `aws.amazon.com/codepipeline-pipeline-arn` |
| ECR | `aws.amazon.com/ecr-image-tags` |
| S3 | `aws.amazon.com/s3-bucket-name` |

---

## 8. Boas práticas de produção

1. **Nunca use credenciais de longo prazo** — use IRSA (EKS) ou ECS Task Role
2. **Escopo mínimo de IAM** — conceda apenas o necessário por plugin
3. **Multi-conta** — use o bloco `aws.accounts` com `roleName` e `AssumeRole`
4. **GitHub App + AWS OIDC** — para pipelines CI/CD que publicam no Backstage

---

## Referências

- [awslabs/backstage-plugins-for-aws](https://github.com/awslabs/backstage-plugins-for-aws)
- [Backstage AWS Integrations Docs](https://backstage.io/docs/integrations/)
- [@backstage/integration-aws-node](https://backstage.io/docs/reference/integration-aws-node/)
- [plugin-catalog-backend-module-aws](https://backstage.io/docs/reference/plugin-catalog-backend-module-aws/)
- [AWS ALB Auth Provider](https://backstage.io/docs/auth/aws-alb/provider)
