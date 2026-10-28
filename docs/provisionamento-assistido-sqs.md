# Provisionamento Assistido com Software Templates — Fila SQS via Pull Request

> Exercício prático: usar um Backstage Software Template para gerar Terraform de uma fila SQS
> e abrir um Pull Request no repositório de infraestrutura. O provisionamento é **assistido**:
> ninguém aplica nada na AWS sem passar por review de PR.
>
> Baseado no exemplo da DevOpsDays SP:
> https://github.com/gabriel-dantas98/backstage-devopsdays-sp/tree/main/templates

## O que é provisionamento assistido?

Em vez de liberar acesso direto ao console/CLI da AWS para todo mundo, a pessoa dev pede
infraestrutura **pelo portal** (Backstage). O portal:

1. Coleta os parâmetros (nome da fila, tags, DLQ) num formulário validado;
2. Renderiza o Terraform a partir de um skeleton (template de arquivos);
3. Abre um **Pull Request** no repositório de infraestrutura;
4. O time de plataforma (ou quem faz review) aprova — só então o Terraform é aplicado.

Vantagens: tudo versionado em Git, auditoria automática, guardrails no formulário
(é o formulário que limita o que dá pra pedir), e a pessoa dev não precisa saber HCL.

## Arquivos criados no projeto

```
examples/aws/sqs/
├── template.yaml      # Definição do Software Template (Scaffolder)
└── skeleton/
    └── main.tf        # Terraform da fila SQS (com placeholders nunjucks)
```

Mais uma alteração de configuração:

- `app-config.yaml` → nova `catalog.locations` apontando para o `template.yaml`.

### 1. O template (`examples/aws/sqs/template.yaml`)

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: terraform-sqs
  title: Provisionar fila SQS (Terraform via PR)
spec:
  owner: group:tech-preta
  type: infra-as-code

  parameters:
    - title: Dados da fila
      required:
        - name
      properties:
        name:
          title: Nome da fila SQS
          type: string
          ui:autofocus: true
        company:          # vira tag Company no recurso
          type: string
          default: platform-team
        create_dlq:       # cria Dead Letter Queue?
          type: boolean
          default: true

  steps:
    - id: fetch-template        # renderiza o skeleton com os valores
      action: fetch:template
      input:
        url: ./skeleton
        values:
          name: ${{ parameters.name }}
          company: ${{ parameters.company }}
          create_dlq: ${{ parameters.create_dlq }}

    - id: terraform_pr          # abre o Pull Request no repo de infra
      action: publish:github:pull-request
      input:
        repoUrl: github.com?repo=backstage&owner=Tech-Preta
        branchName: 'backstage/sqs/${{ parameters.name }}'
        sourcePath: ./outputs/terraform
        targetPath: 'terraform/aws/production/sqs/${{ parameters.name }}'

    - id: label_pr              # rotula o PR para facilitar triagem
      action: github:issues:label
      input:
        labels: [terraform, created-by-backstage, sqs]
```

Pontos importantes:

- **`parameters`** = o formulário que a pessoa preenche. É aqui que ficam os guardrails:
  nada de campo livre "edite o Terraform como quiser".
- **`fetch:template`** renderiza o skeleton com [nunjucks](https://mozilla.github.io/nunjucks/):
  `${{ values.name }}` vira o nome da fila, e `{%- if values.create_dlq %}` inclui
  condicionalmente o `redrive_policy`.
- **`publish:github:pull-request`** cria a branch, comita o arquivo e abre o PR —
  o repositório de destino é fixo (`Tech-Preta/backstage`), transparente para quem pede.

### 2. O skeleton (`examples/aws/sqs/skeleton/main.tf`)

```hcl
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
```

Usa o módulo oficial [terraform-aws-modules/sqs](https://registry.terraform.io/modules/terraform-aws-modules/sqs/aws/latest).
Para o exercício o state é **local** (sem backend remoto).

### 3. Registro no catálogo (`app-config.yaml`)

```yaml
catalog:
  locations:
    # Terraform SQS - provisionamento assistido via PR
    - type: file
      target: ../../examples/aws/sqs/template.yaml
      rules:
        - allow: [Template]
```

> **Armadilha clássica:** template que não aparece no Create é, quase sempre,
> location não registrada (ou registrada sem `rules: allow: [Template]`).

## O que adaptamos do exemplo original

| Original (DevOpsDays SP)                | Nosso                                        |
| --------------------------------------- | -------------------------------------------- |
| Repo de destino hardcoded do palestrante | `Tech-Preta/backstage` (fixo, sem expor ao usuário) |
| `create_dlq` forçado `"true"` no input   | Parâmetro booleano de verdade no formulário  |
| Backend de state S3 no skeleton          | State local (exercício); S3 em produção      |
| `owner: user:gabriel-dantas`             | `owner: group:tech-preta`                    |
| Campos "nome" e "empresa" sem função real | Nome = recurso, company = tag AWS           |

## Problemas que resolvemos no caminho (e como evitar)

### 1. Backend não subia: `SASL: client password must be a string`

O `app-config.yaml` usa Postgres via variáveis `${POSTGRES_*}`, mas o `.env`
não tinha os valores. O Backstage **não carrega `.env` automaticamente** — o script
`start` usa `dotenv -e .env -- backstage-cli repo start`, então toda variável
referenciada no config precisa existir no `.env`:

```env
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=backstage
POSTGRES_USER=backstage
POSTGRES_PASSWORD=backstage
```

Sintoma secundário: com o backend quebrado, **todas** as rotas `/api/*` respondem 404
(o roteador sobe, mas nenhum plugin inicializa). Se `curl localhost:7007/api/...`
der 404 com o processo de pé, procure erro de startup no log, não rota faltando.

### 2. `publish:github:pull-request` falhou com `Git Repository is empty`

O GitHub não permite abrir PR num repositório sem nenhum commit — não existe branch base.
O `Tech-Preta/backstage` existia, mas estava vazio. Solução: commit inicial (um README)
via API:

```bash
# cria README.md e, com ele, a branch main
curl -s -X PUT -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/Tech-Preta/backstage/contents/README.md \
  -d '{"message": "chore: initial commit", "content": "<base64 do arquivo>"}'
```

> Para o exercício em aula: se o repo de destino estiver vazio, o PR falha sempre.
> Um commit inicial resolve. Cheque antes com
> `gh repo view Tech-Preta/backstage` (ou pela API) se há commits.

### 3. Reinício do dev server

O dev server carrega o `app-config.yaml` na inicialização. Depois de registrar uma
location nova, reinicie com:

```bash
yarn start   # (não existe script "dev" neste projeto)
```

## Passo a passo do exercício

1. **Suba o ambiente**

   ```bash
   docker compose up -d postgres    # banco do Backstage
   yarn start                       # frontend :3000, backend :7007
   ```

2. **Confira se o template está no catálogo**

   ```bash
   curl -s 'http://localhost:7007/api/catalog/entities?filter=kind=template' \
     | grep -o 'terraform-sqs'
   ```

3. **No portal**: `http://localhost:3000` → **Create** →
   "Provisionar fila SQS (Terraform via PR)".

4. **Preencha o formulário** e execute. Acompanhe as tasks:

   - *Renderizar Terraform* — skeleton vira `main.tf` com seus valores;
   - *Criar Pull Request* — branch `backstage/sqs/<nome>` + PR em `Tech-Preta/backstage`;
   - *Adicionar labels* — `terraform`, `created-by-backstage`, `sqs`.

5. **Revise o PR** no GitHub: veja o `main.tf` gerado em
   `terraform/aws/production/sqs/<nome>/`, comente/aprove.

6. **(Opcional, para fechar o ciclo)** Aplique de fato — é a parte que o PR
   liberaria após o review:

   ```bash
   git clone git@github.com:Tech-Preta/backstage.git && cd backstage
   git checkout backstage/sqs/<nome-da-fila>
   cd terraform/aws/production/sqs/<nome-da-fila>
   terraform init && terraform plan   # plan mostra a fila SQS a criar
   ```

   ⚠️ `terraform apply` cria recursos reais na sua conta AWS — rode só se
   quiser ver a fila aparecer, e `terraform destroy` depois do exercício.

## Limpeza

- Fila criada na AWS: `terraform destroy` no diretório do step.
- Branch e PR: feche/mescle o PR e apague a branch no GitHub.

## Referências

- [Software Templates — docs Backstage](https://backstage.io/docs/features/software-templates/)
- [Exemplo base (DevOpsDays SP)](https://github.com/gabriel-dantas98/backstage-devopsdays-sp/tree/main/templates)
- [Módulo SQS — Terraform Registry](https://registry.terraform.io/modules/terraform-aws-modules/sqs/aws/latest)
- [Writing Templates — field reference](https://backstage.io/docs/features/software-templates/writing-templates/)
