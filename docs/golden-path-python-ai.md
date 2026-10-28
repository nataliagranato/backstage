# Golden Path assistido por IA — Template Python no Backstage

Este guia explica, passo a passo, como foi construído um **golden path** no Backstage: um Software Template em que o desenvolvedor descreve em linguagem natural o que precisa e a IA (modelo `deepseek-v4-flash` via gateway Verboo) gera o projeto completo — código Python, Dockerfile, manifests Kubernetes e políticas Kyverno — que é publicado no GitHub e registrado automaticamente no catálogo.

## Visão geral do fluxo

```
Desenvolvedor → Create (template Python)
    │  preenche: nome do repo + "o que sua API deve fazer?"
    ▼
1. verboo:generate:python  (custom action)
    │  POST para o Verboo → IA devolve JSON com os arquivos
    │  arquivos escritos no workspace temporário do Scaffolder
    ▼
2. publish:github  (action nativa)
    │  cria o repositório e faz push do conteúdo
    ▼
3. catalog:register  (action nativa)
    │  registra o catalog-info.yaml gerado pela IA
    ▼
Componente visível no Catalog do Backstage
```

## Arquitetura da solução

Três peças trabalham juntas:

| Peça | Arquivo | Papel |
|---|---|---|
| Custom action | `packages/backend/src/verboo-actions.ts` | Chama a IA e escreve os arquivos no workspace |
| Registro no backend | `packages/backend/src/index.ts` | Carrega a action no plugin scaffolder |
| Software Template | `examples/python/template.yaml` | Formulário + orquestração dos passos |

A localização do template é declarada em `app-config.yaml`, na seção `catalog.locations`, para que o catalog o ingira automaticamente.

---

## Passo 1 — Criar a custom action no backend

O backend deste projeto usa o **novo sistema de backend** (`createBackend()`), então a action é empacotada como um *backend module* e registrada com `backend.add()`.

Arquivo: `packages/backend/src/verboo-actions.ts`

### 1.1 Estrutura do módulo

```ts
import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  scaffolderActionsExtensionPoint,
  createTemplateAction,
} from '@backstage/plugin-scaffolder-node';
import { promises as fs } from 'fs';
import * as path from 'path';
```

> **Nota de versão:** a partir do `@backstage/plugin-scaffolder-node` 0.13.x, o `schema` usa **factories zod** — `input: z => z.object({...})` — e não mais JSON Schema puro. O `z` é injetado pelo Backstage, você não importa o zod diretamente.

### 1.2 O prompt de sistema

O prompt define o "contrato" com a IA: o que gerar e em qual formato.

```ts
const SYSTEM_PROMPT = `You are a platform engineer.
Generate the file structure for a Python project.
Include: a Dockerfile, requirements.txt, a minimal FastAPI app, and Kubernetes manifests.
For security, you MUST include Kyverno policies for validation (do not use OPA).
Always include a catalog-info.yaml Backstage entity of kind Component at the repository root, with exactly this shape:
---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: <repository-name>
  description: <short description>
  annotations:
    github.com/project-slug: Tech-Preta/<repository-name>
spec:
  type: service
  lifecycle: production
  owner: group:tech-preta
---
Do not add any other fields to catalog-info.yaml (no system, no language, no metadata.owner).
Return strictly a JSON object in the format: {"files": [{"path": "main.py", "content": "..."}]}
No markdown fences, no explanations - JSON only.`;
```

Dois detalhes importantes:

- **`catalog-info.yaml` obrigatório** — é ele que permite o passo final `catalog:register` fechar o golden path automaticamente.
- **JSON estrito** — sem `response_format` da API (ver a seção "Pegadinhas"), a adesão ao formato vem do prompt + parser tolerante.

### 1.3 O handler: chamar a IA e escrever os arquivos

```ts
async handler(ctx) {
  const apiKey = process.env.VERBOO_API_KEY;
  const endpoint = process.env.VERBOO_ENDPOINT ?? 'https://code.verboo.ai/router/v1';

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: ctx.input.prompt },
      ],
    }),
    signal: AbortSignal.timeout(120_000), // geração de projeto pode demorar
  });

  const data = await response.json();
  const aiContent = parseAiJson(data.choices[0].message.content);

  for (const file of aiContent.files) {
    const fullPath = path.join(ctx.workspacePath, file.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content, 'utf8');
    ctx.logger.info(`Created file: ${file.path}`);
  }
  ctx.output('fileCount', aiContent.files.length);
}
```

Pontos-chave:

- **`ctx.workspacePath`** é o diretório temporário que o Scaffolder entrega a cada execução — é lá que as actions nativas (`publish:github`, etc.) esperam encontrar os arquivos.
- **`fetch` nativo** em vez de `axios`: não adiciona dependência.
- **Timeout de 120s**: geração de um projeto completo com LLM leva de 20s a 1min+.

### 1.4 Parser tolerante do JSON

LLMs às vezes envolvem o JSON em code fences (` ```json `). O parser remove os fences antes do `JSON.parse`:

```ts
function parseAiJson(raw: string) {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed = JSON.parse(stripped);
  if (!Array.isArray(parsed.files)) {
    throw new Error('AI response did not contain a "files" array');
  }
  return parsed;
}
```

### 1.5 O módulo de registro

```ts
export const scaffolderVerbooModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'verboo-actions',
  register(env) {
    env.registerInit({
      deps: { actions: scaffolderActionsExtensionPoint },
      async init({ actions }) {
        actions.addActions(createVerbooGenerateAction());
      },
    });
  },
});

export default scaffolderVerbooModule;
```

> O `export default` é obrigatório: `backend.add(import('./verboo-actions'))` exige `{ default: BackendFeature }`.

### 1.6 Registrar no backend

Em `packages/backend/src/index.ts`:

```ts
// custom scaffolder actions
backend.add(import('./verboo-actions'));
```

---

## Passo 2 — Criar o Software Template

Arquivo: `examples/python/template.yaml`

### 2.1 Metadados e parâmetros

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: python
  title: Python
spec:
  owner: group:tech-preta
  type: service
```

O formulário pede apenas o essencial — **Repository name** e **What should your API do?** O host (`github.com`) e o owner (`Tech-Preta`) são transparentes para o usuário: a integração é com a organização Tech Preta e estão fixados no template, não no formulário.

### 2.2 Os três passos

```yaml
steps:
  - id: ai-generate
    name: Generating code with AI
    action: verboo:generate:python
    input:
      prompt: ${{ parameters.prompt }}

  - id: publish
    name: Publishing to GitHub
    action: publish:github
    input:
      description: Python project generated by AI
      # host and owner are fixed by the Tech-Preta integration, not exposed
      # to the user
      repoUrl: github.com?repo=${{ parameters.name }}&owner=Tech-Preta
      defaultBranch: main

  - id: register
    name: Registering in the catalog
    action: catalog:register
    input:
      repoContentsUrl: ${{ steps.publish.output.repoContentsUrl }}
      catalogInfoPath: /catalog-info.yaml
```

Repare no encadeamento de saídas: `steps.publish.output.repoContentsUrl` alimenta o passo de registro. **Não há `fetch:template`** — a IA já escreve todos os arquivos diretamente no workspace; as actions nativas fazem o resto.

### 2.3 Registrar o template no catálogo

Em `app-config.yaml`, dentro de `catalog.locations`:

```yaml
- type: file
  target: ../../examples/python/template.yaml
  rules:
    - allow: [Template]
```

---

## Passo 3 — Configurar as variáveis de ambiente

O `.env` na raiz do projeto (não versionado) precisa de:

```bash
VERBOO_API_KEY=sua-chave
VERBOO_ENDPOINT=https://code.verboo.ai/router/v1
GITHUB_TOKEN=seu-token-com-escopo-de-criar-repos
```

O `start` do projeto (`dotenv -e .env -- backstage-cli repo start`) carrega essas variáveis para o processo do backend — é assim que `process.env.VERBOO_API_KEY` resolve dentro da action.

> **Regra:** no `.env` de dev vão só segredos. `NODE_ENV` **não** deve estar lá (nem exportado no shell) — se estiver `production`, o guest auth retorna 403.

---

## Passo 4 — Usar o golden path

1. Suba o servidor: `yarn start` (na raiz do projeto).
2. Acesse `http://localhost:3000` e vá em **Create**.
3. Escolha o template **Python**.
4. Preencha:
   - **Repository name**: ex. `delivery-routes-api`
   - **What should your API do?**: ex. `A FastAPI service to calculate delivery routes.`
5. Clique em **Create** e acompanhe os três passos no log da task.
6. Ao final, o output traz o link do repositório e a entidade já registrada no **Catalog**.

O repositório gerado contém (exemplo real de uma execução, 15 arquivos):

```
main.py                     # app FastAPI
requirements.txt
Dockerfile / .dockerignore
catalog-info.yaml           # entidade Component para o Backstage
k8s/                        # deployment, service, namespace, networkpolicy
policies/                   # 6 políticas Kyverno (require-probes, resources, ...)
```

Para testar localmente o que foi gerado, aplique os manifests em um cluster local (kind/k3s) com `kubectl apply -f k8s/` — as políticas Kyverno validam os manifests no admission.

---

## Pegadinhas encontradas (e como resolver)

Estes problemas apareceram durante a construção — se bater neles, há caminho conhecido:

### 403 `structured_output_not_enabled` na chamada à IA

O gateway Verboo **rejeita `response_format: { type: 'json_object' }`** no plano atual:

```json
{"code":"structured_output_not_enabled","error":"structured output is not enabled for this plan"}
```

**Solução:** não use `response_format`. Force JSON via prompt de sistema e use o `parseAiJson` (com remoção de fences) no lado do cliente. Comprovado em teste: o modelo devolve JSON limpo sem o parâmetro.

### `409 ConflictError: Location already exists` no passo register

Ao apagar uma entidade registrada (Component/Location) e tentar registrar **a mesma URL** de novo, o catalog retorna 409: a location key persiste no banco (refresh state) mesmo após a deleção da entidade. Com `:memory:` em dev, só um restart do backend limpa; em produção (Postgres), remova a linha órfã de `refresh_state_references` ou registre com URL diferente. Para testes, o caminho mais simples é trocar o nome do repositório.

### `Bad credentials` no passo publish (GitHub)

O `dotenv-cli` **não sobrescreve** variáveis já exportadas no shell. Se você tem um `GITHUB_TOKEN` antigo/revogado no `~/.bashrc` (ou exportado na sessão), o backend usa ele — não o do `.env` — e o `publish:github` falha com `Bad credentials`. Diagnóstico: compare o token do processo com o do `.env` (ex.: via `/proc/<pid>/environ` — nunca imprima o valor). Solução: `env -u GITHUB_TOKEN -u NODE_ENV yarn start` e remova o export antigo do rc file.

### `InputError: ... additional property "allowedHosts"` no passo publish

`allowedHosts` **não é input da action `publish:github`** — é opção do widget `RepoUrlPicker` do frontend. Se o `repoUrl` é fixado no template (owner transparente ao usuário), o `allowedHosts` não tem onde ficar e causa `InputError` na validação do schema. Solução: remova-o do `input` do step. Use-o apenas dentro de `ui:options` de um `RepoUrlPicker`.

### `createTemplateAction` com 1 genérico não compila

A API v2 do scaffolder exige schema em factories zod:

```ts
// ERRADO (API antiga, JSON Schema)
schema: { input: { type: 'object', properties: { prompt: { type: 'string' } } } }

// CERTO (API v2)
schema: { input: z => z.object({ prompt: z.string() }) }
```

### `backend.add(import('./meu-modulo'))` não compila

O import dinâmico exige `export default` no módulo — um export nomeado não basta.

### Todas as rotas `/api/*` retornam 404 ("Failed to load entity types")

Não é problema de plugin: o backend **não terminou de subir**. O healthcheck `/.backstage/health/v1/readiness` responde `503 Backend has not started yet`. Causa comum aqui: `better-sqlite3` compilado para uma versão de Node diferente da que roda o processo (`NODE_MODULE_VERSION` mismatch). Corrija com `npm rebuild better-sqlite3` e reinicie sem `NODE_ENV=production`: `env -u NODE_ENV yarn start`.

---

## Próximos passos possíveis

- **Retry do parse**: se a IA desobedecer ao formato, re-chamar com a mensagem de erro.
- **Mais templates**: o mesmo padrão (action custom + template) se replica para Go, Node, etc., trocando o `SYSTEM_PROMPT`.
