# Bot aws-ops: deploy, rollback e status de stacks AWS direto do Backstage

Guia da aula. Em pouco mais de uma hora você vai provisionar uma API serverless
na AWS **sem abrir o console**, usando o Backstage como botão vermelho/verde —
com rollback de verdade e histórico de auditoria.

---

## 1. O que o bot faz

O plugin `aws-ops` (backend em `packages/backend/src/aws-ops.ts`) transforma o
Backstage em um bot operacional para **stacks Terraform/OpenTofu na AWS**:

| Operação | Endpoint | Quem dispara |
|---|---|---|
| Deploy | `POST /api/aws-ops/deploy` | `curl` / Scaffolder (aula) |
| Rollback (versão anterior) | `POST /api/aws-ops/rollback` | Card da entidade |
| Status | `GET /api/aws-ops/status?stack=<nome>` | Card da entidade (poll de 15s) |
| Audit log | `GET /api/aws-ops/audit` | `curl` |

Como funciona por dentro:

1. O bot recebe o **template HCL** (só resources; `backend.tf` e `provider.tf`
   são gerados automaticamente com backend S3 apontando para o bucket do bot).
2. Roda `terraform init` + `terraform apply -auto-approve` em um workdir em
   `/tmp/aws-ops/<stack>` usando o binário configurado (`terraform` ou `tofu`).
3. Versiona o template no S3 (`templates/<stack>/<timestamp>.tf`) e grava um
   ponteiro `CURRENT` com `{key, versionId}` — é daí que sai o rollback: ele
   pega a versão anterior via `ListObjectVersions` + `GetObject` com `VersionId`
   e reaplica.
4. Toda operação é registrada na tabela `aws_ops_audit` (sqlite local) com
   `action`, `stack` e `result`.

**Limites de projeto deliberado:** não existe operação de `destroy`. O bot é
espalhamento, correção (rollback) e observação — apagar infraestrutura fica
fora do escopo de propósito.

---

## 2. Setup AWS (uma vez)

### 2.1 Bootstrap do bucket de state

O bot guarda **states e templates no mesmo bucket S3** (com versionamento
habilitado, que é o que torna o rollback possível). O bucket é criado uma vez
com o módulo em `examples/aws/bootstrap/` — que usa **state local de propósito**
(é o clássico ovo-galinha: o primeiro state precisa viver em algum lugar que
não dependa dele mesmo; ~2 recursos: bucket + versioning).

```bash
cd examples/aws/bootstrap
terraform init
terraform apply -var="bucket=SEU_BUCKET"
```

Escolha um nome globalmente único (ex.: `alura-aws-ops-templates-suaparte`).

### 2.2 Credenciais no `.env`

Copie `.env.example` para `.env` e preencha o bloco AWS:

```dotenv
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_OPS_BUCKET=SEU_BUCKET        # o bucket do passo 2.1
TF_BINARY=tofu                   # ou terraform, se preferir
```

As credenciais seguem a **chain padrão do AWS SDK** (`.env` → variáveis de
ambiente → `~/.aws/credentials`): tanto a CLI `tofu`/`terraform` quanto o SDK
usado para versionar templates no S3 as herdam. Se a conta da sua organização
já configura `AWS_PROFILE`, também funciona.

O bloco `awsOps` do `app-config.yaml` lê essas variáveis:

```yaml
awsOps:
  binary: ${TF_BINARY}
  bucket: ${AWS_OPS_BUCKET}
  region: ${AWS_REGION}
```

### 2.3 Policy IAM mínima (least-privilege, didática)

Crie um usuário IAM para o bot com esta policy. Ela cobre exatamente o que o
bot executa na aula — nada mais:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject", "s3:GetObject", "s3:ListBucket",
        "s3:ListBucketVersions", "s3:GetObjectVersion"
      ],
      "Resource": [
        "arn:aws:s3:::SEU_BUCKET",
        "arn:aws:s3:::SEU_BUCKET/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration",
        "lambda:GetFunction", "lambda:ListFunctions", "lambda:TagResource"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["dynamodb:CreateTable", "dynamodb:DescribeTable", "dynamodb:DeleteTable", "dynamodb:UpdateTable", "dynamodb:ListTables", "dynamodb:TagResource"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "iam:PassRole", "iam:GetRole", "iam:CreateRole", "iam:DeleteRole",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:ListAttachedRolePolicies", "iam:ListRolePolicies"
      ],
      "Resource": "*"
    }
  ]
}
```

Pontos didáticos:

- O primeiro statement é escopado **por bucket** (troque `SEU_BUCKET`); os de
  Lambda/DynamoDB/IAM usam `Resource: "*"` porque essas APIs não aceitam ARN
  por recurso-alvo em todas as ações — em produção, restrinja por prefixo de
  nome de role/função com `Condition`.
- Tudo dentro do **Free Tier** para a aula: 1 Lambda 128 MB, 1 tabela DynamoDB
  `PAY_PER_REQUEST` e o bucket S3 (cuidado só com o versionamento acumulando
  objetos pequenos — apague o bucket ao fim da aula, fora do bot).

---

## 3. Anotação da entidade e registro no catálogo

O card "Operações AWS" aparece na página da entidade quando ela carrega a
anotação `alura.tech/aws-stack` cujo valor é o nome da stack (mesmo
`stackName` usado na API). Modelo pronto em
`examples/aws/catalog-aws-component.yaml`:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: minha-api-serverless
  description: API serverless gerenciada pelo bot aws-ops da aula
  annotations:
    alura.tech/aws-stack: minha-api-serverless
spec:
  type: service
  lifecycle: production
  owner: group:tech-preta
```

Registre o arquivo no catálogo (Menu → Create → Register Existing Component,
apontando para a URL do YAML) e a entidade já ganha o card. Sem a anotação, o
card mostra a instrução em vez dos botões.

---

## 4. Fluxo da aula

O stack de exemplo (`examples/aws/stack-example.tf`) provisiona um Lambda
hello-world em Python 3.12 + uma tabela DynamoDB — o backend/provider são
gerados pelo bot, o arquivo tem só resources.

**Passo 1 — deploy inicial** (com o Backstage rodando em `localhost:7007`):

```bash
curl -X POST http://localhost:7007/api/aws-ops/deploy \
  -H 'Content-Type: application/json' \
  -d "{\"stackName\":\"minha-api-serverless\",\"templateBody\":$(python3 -c 'import json;print(json.dumps(open("examples/aws/stack-example.tf").read()))')}"
```

(ou, mais simples, use `jq`: `-d "{\"stackName\":\"minha-api-serverless\",\"templateBody\":\"$(cat examples/aws/stack-example.tf)\"}"`)

Resposta esperada: `{"action":"deploy","versionId":"..."}`. O apply demora
uns 30-60s. No card da entidade o status vira **provisionada**.

**Passo 2 — deploy com mudança:** edite o `stack-example.tf` para mudar a
mensagem do Lambda (ex.: `"hello from aws-ops v2"`) e repita o `curl`. Uma
nova versão do template é gravada no bucket e `CURRENT` passa a apontar para
ela.

**Passo 3 — rollback pelo card:** na página da entidade, clique **Rollback** e
confirme. O bot pega a versão anterior do template, reaplica e devolve
`{"action":"rollback","versionId":"..."}`. Invocar a função confirma que a
mensagem voltou para `v1`.

**Passo 4 — conferir o audit log:**

```bash
curl http://localhost:7007/api/aws-ops/audit
# ou filtrando por stack:
curl "http://localhost:7007/api/aws-ops/audit?stack=minha-api-serverless"
```

Você verá os registros de `deploy` e `rollback` (com erros registrados quando
houver). Toda a trilha da aula está lá.

---

## 5. Limitações conscientes e caminho de evolução

Limitações assumidas para o escopo da aula (todas em `docs` do código):

- **Sem `destroy`** — decisão de projeto: o bot só aplica, reverte e observa.
- **Card só faz rollback e status** — o deploy inicial é via API (`curl` /
  Scaffolder), evitando que qualquer visitante do portal aplique infra.
- **Audit em sqlite local** — histórico limitado ao disco do Backstage; não é
  fonte de verdade de compliance.
- **Workdir em `/tmp`** — states ficam no S3, mas o `.terraform` local se perde
  a cada reboot (irrelevante: `init` roda a cada operação).
- **Sem lock de state** — dois applies simultâneos na mesma stack corrompem o
  paralelismo do Terraform; um apply por vez.

Caminho de evolução natural, na ordem de menor esforço para maior:

1. **RBAC** no backend (`@backstage/plugin-permission`) para restringir
   rollback por dono da entidade.
2. **Scaffolder action `awsOps:deploy`** — template self-service que envia o
   HCL do repositório da pessoa usuária.
3. **Lock com DynamoDB** (`use_lockfile`/tabela de lock) para permitir applies
   concorrentes com segurança.
4. **Templates por repositório** — o bot busca o HCL direto do repo (via
   `fetch:template`) em vez de receber o corpo no request.
5. **Notificações Slack** no fim de cada deploy/rollback usando o resultado do
   audit.
