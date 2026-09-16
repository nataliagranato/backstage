# Spec: Bot Operacional AWS no Backstage (aws-ops)

**Data:** 2026-09-16 · **Status:** aguardando revisão
**Contexto:** curso Alura (Platform Engineering), projeto `alura-online` (Backstage 1.54.0, novo frontend system, backend `createBackend`), conta AWS Free Tier pessoal.

## Objetivo

Card "Operações AWS" na página da entidade no Backstage que permite **deploy, rollback e consulta de status** de uma stack CloudFormation (Lambda + DynamoDB + S3) na conta AWS da usuária — didático: os alunos veem o código completo do plugin, do SDK ao UI.

## Decisões

| Decisão | Escolha | Motivo |
|---|---|---|
| Plugin da AWS oficial (`aws-apps`) | Rejeitado | Exige Organizations/multi-account + EKS (caro); complexidade incompatível com curso |
| Scaffolder actions Roadie | Rejeitado | Fluxo vira "rodar template", não botão operacional na página do serviço |
| **Backend module próprio** | **Escolhido** | ~3-4 arquivos, código todo visível para didática, controle total das ações |
| Mecanismo de deploy/rollback | **Terraform/OpenTofu** | IaC é o tema da aula; binário configurável (`awsOps.binary`, default `terraform`, OpenTofu compatível); templates HCL versionados em S3 (versioning) |
| Serviços alvo | Lambda + DynamoDB + S3 | Cabem no Free Tier |
| Credenciais | Default credential chain (perfil local / env) | Zero chaves no repo; segue o guia de 14/09 |
| Acionamento | UI do Backstage (card na entidade) | Escolha da usuária |

## Arquitetura

```
packages/app (novo frontend system)
└── plugins/aws-ops (frontend)  → card "Operações AWS" na página da entidade
      └── chama /api/aws-ops via fetchApi

plugins/aws-ops-backend (novo backend module @internal/plugin-aws-ops-backend)
├── GET  /status   → describeStacks (estado atual da stack da entidade)
├── POST /deploy   → upload do template p/ S3 versionado + createOrUpdateStack
├── POST /rollback → redeploy do template da versão anterior (S3 versioning)
└── audit log      → tabela sqlite local (via @backstage/backend-plugin-api databaseService)
```

AWS SDK v3 (`@aws-sdk/client-s3`) para versionamento de templates. Deploy/rollback via **Terraform/OpenTofu CLI** (`execFile`), binário configurável em `app-config.yaml` (`awsOps.binary`, default `terraform`; `tofu` compatível), workdir por stack em `/tmp/aws-ops/<stack>`, state no S3 (backend s3 com bucket versionado). Região e bucket via `app-config.yaml` (`awsOps.bucket`, `awsOps.region`).

## Fluxo de deploy/rollback (Terraform)

1. Cada deploy copia o template HCL para `s3://<bucket>/terraform/<stack>/<timestamp>.tf` (versioning ativo) e grava ponteiro `CURRENT`.
2. Deploy = escrever HCL no workdir + `init -backend-config=...` + `apply -auto-approve` (state no S3, key por stack).
3. Rollback = buscar versão HCL anterior no S3 (listagem por timestamp), escrever no workdir e `apply` — o provider reconcilia o drift.
4. Status = `output -json` no workdir (state existente) ou 404 "não provisionada".

## Governação (didática, mínima)

- Confirmação no UI antes de ação mutante (deploy/rollback) — modal nativo.
- Audit log em sqlite: timestamp, ação, stack, resultado. Exibido no próprio card.
- Sem RBAC multi-usuário (YAGNI para curso; backend já tem `allow-all-policy`).
- IAM: usuário dedicado com policy mínima (`cloudformation:Create*Update*Describe*`, `s3:GetObject/PutObject/ListBucket` no bucket de templates, `lambda:*`, `dynamodb:*` escopados aos recursos da stack). Documentado no guia da aula.

## Arquivos novos

```
plugins/aws-ops-backend/
├── package.json
├── src/module.ts          (backendPlugin + rotas)
├── src/routes.ts          (handlers: status/deploy/rollback + audit)
└── src/index.ts

plugins/aws-ops/
├── package.json
└── src/
    ├── plugin.ts          (extension: EntityCardContent no novo frontend system)
    ├── AwsOpsCard.tsx     (status + botões Deploy/Rollback + modal confirmação)
    └── index.ts

Registro:
- packages/backend/src/index.ts  → backend.add(import('@internal/plugin-aws-ops-backend'))
- packages/app/src/App.tsx       → feature do card via navModule/feature list
```

## Exemplo de uso (aula)

Entidade no catálogo anota a stack alvo:

```yaml
metadata:
  annotations:
    alura.tech/aws-stack: minha-api-serverless
```

O card lê a anotação, mostra status da stack (CREATE_COMPLETE etc.) e expõe os botões.

## Testes

- Backend: handlers testados com `@aws-sdk/client-*` mockado via jest (padrão do repo: `yarn run test` → `backstage-cli repo test`); scaffolding dos plugins via `yarn new backstage:plugin` (usando `backend-module` e `frontend-plugin` nos templates).
- Frontend: `yarn run test` existente cobre render do card com `fetchApi` mockado.
- Verificação manual: deploy de stack-exemplo.tf (Lambda hello-world + tabela DynamoDB em HCL) na conta Free Tier, rollback, e conferência do audit log.

## Fora de escopo

- Multi-account/Organizations, Cost Insights, Security Hub.
- Slack/chatops (card UI apenas; Slack já existe via @hermes e pode ser integrado depois).
- Destruição de recursos (`DeleteStack`) — só deploy/rollback/status.

## Referências

- Guia prévio de plugins AWS read-only: `docs/backstage-aws-integration.md` (14/09)
- awslabs/backstage-plugins-for-aws (pesquisa pendente de rede — não bloqueia, abordagem não usa esses plugins)
