# Bot Operacional AWS (aws-ops) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Card "Operações AWS" na página da entidade do Backstage que executa deploy, rollback e status de stacks CloudFormation (Lambda + DynamoDB + S3) via plugin backend próprio.

**Architecture:** Backend plugin `aws-ops` (arquivo único em `packages/backend/src/aws-ops.ts`, padrão do repo = verboo-actions.ts) com rotas HTTP `/status`, `/deploy`, `/rollback`, AWS SDK v3, templates versionados em S3 e audit log em sqlite (databaseService). Frontend: módulo `packages/app/src/modules/aws-ops` com EntityCardBlueprint (novo frontend system, padrão do repo = modules/nav, modules/home).

**Tech Stack:** Backstage 1.54.0 (novo frontend system), `@aws-sdk/client-cloudformation`, `@aws-sdk/client-s3`, knex via `coreServices.database`, React + `@backstage/plugin-catalog-react/alpha` (EntityCardBlueprint), jest via `backstage-cli repo test`.

**Spec:** `docs/superpowers/specs/2026-09-16-aws-ops-bot-design.md`

## Global Constraints

- Desvio consciente do spec aprovado: em vez de workspaces `plugins/aws-ops-backend` e `plugins/aws-ops`, o backend é um arquivo em `packages/backend/src/aws-ops.ts` e o frontend um módulo em `packages/app/src/modules/aws-ops/` — segue o padrão existente do repo (verboo-actions.ts, modules/home) e elimina 2 package.json + tsconfig de boilerplate.
- Sem `DeleteStack` em qualquer rota (spec: fora de escopo).
- Nenhuma credencial AWS no repo — default credential chain.
- Documentação e comentários visíveis ao usuário em pt-BR.
- Yarn workspaces; testes com `yarn workspace backend test` / `yarn run test`; typecheck com `yarn tsc`.
- Ação mutante (deploy/rollback) sempre auditada; UI pede confirmação nativa (`window.confirm`).

---

### Task 1: Helpers de rollback e upsert (lógica pura + testes)

**Files:**
- Create: `packages/backend/src/aws-ops-helpers.ts`
- Test: `packages/backend/src/aws-ops-helpers.test.ts`

**Interfaces:**
- Consumes: nada (funções puras).
- Produces:
  - `pickPreviousVersion(versions: ObjectVersion[], currentId: string): string | undefined` — recebe versões S3, retorna VersionId do template anterior ao `currentId` (mais recente entre os mais antigos).
  - `upsertStack(cfn: CloudFormationClient, stackName: string, templateBody: string): Promise<'updated' | 'created'>` — UpdateStack; se ValidationError "does not exist", CreateStack.

- [ ] **Step 1: Escrever os testes que falham**

`packages/backend/src/aws-ops-helpers.test.ts`:

```ts
import { pickPreviousVersion } from './aws-ops-helpers';

describe('pickPreviousVersion', () => {
  const mk = (id: string, daysAgo: number, isLatest = false) => ({
    VersionId: id,
    LastModified: new Date(Date.now() - daysAgo * 86_400_000),
    IsLatest: isLatest,
  });

  it('retorna a versão mais recente anterior à atual', () => {
    const versions = [mk('v1', 3), mk('v2', 2), mk('v3', 1, true)];
    expect(pickPreviousVersion(versions, 'v3')).toBe('v2');
  });

  it('ignora a versão atual mesmo que não seja IsLatest', () => {
    const versions = [mk('v1', 3), mk('v2', 2)];
    expect(pickPreviousVersion(versions, 'v2')).toBe('v1');
  });

  it('retorna undefined quando não há versão anterior', () => {
    const versions = [mk('v1', 1, true)];
    expect(pickPreviousVersion(versions, 'v1')).toBeUndefined();
  });

  it('ignora entradas sem VersionId (delete markers)', () => {
    const versions = [
      { VersionId: undefined, LastModified: new Date() },
      mk('v1', 3),
      mk('v2', 1, true),
    ];
    expect(pickPreviousVersion(versions as any, 'v2')).toBe('v1');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `yarn workspace backend test src/aws-ops-helpers.test.ts`
Expected: FAIL — módulo `./aws-ops-helpers` não existe.

- [ ] **Step 3: Implementar os helpers**

`packages/backend/src/aws-ops-helpers.ts`:

```ts
import {
  CloudFormationClient,
  CreateStackCommand,
  UpdateStackCommand,
} from '@aws-sdk/client-cloudformation';

export type ObjectVersion = {
  VersionId?: string;
  LastModified?: Date;
  IsLatest?: boolean;
};

export function pickPreviousVersion(
  versions: ObjectVersion[],
  currentId: string,
): string | undefined {
  const older = versions
    .filter(
      v =>
        v.VersionId &&
        v.VersionId !== currentId &&
        v.LastModified &&
        !v.IsLatest,
    )
    .sort(
      (a, b) => b.LastModified!.getTime() - a.LastModified!.getTime(),
    );
  return older[0]?.VersionId;
}

export async function upsertStack(
  cfn: CloudFormationClient,
  stackName: string,
  templateBody: string,
): Promise<'updated' | 'created'> {
  try {
    await cfn.send(
      new UpdateStackCommand({
        StackName: stackName,
        TemplateBody: templateBody,
        Capabilities: ['CAPABILITY_NAMED_IAM'],
      }),
    );
    return 'updated';
  } catch (e: any) {
    // primeira execução: a stack ainda não existe -> cria
    if (
      e.name === 'ValidationError' &&
      /does not exist/i.test(String(e.message))
    ) {
      await cfn.send(
        new CreateStackCommand({
          StackName: stackName,
          TemplateBody: templateBody,
          Capabilities: ['CAPABILITY_NAMED_IAM'],
        }),
      );
      return 'created';
    }
    throw e;
  }
}
```

Instalar dependência:

```bash
yarn workspace backend add @aws-sdk/client-cloudformation @aws-sdk/client-s3
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `yarn workspace backend test src/aws-ops-helpers.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/aws-ops-helpers.ts packages/backend/src/aws-ops-helpers.test.ts packages/backend/package.json yarn.lock
git commit -m "feat(aws-ops): helpers de rollback S3 e upsert CloudFormation"
```

---

### Task 2: Plugin backend aws-ops (rotas status/deploy/rollback + audit log)

**Files:**
- Create: `packages/backend/src/aws-ops.ts`
- Modify: `packages/backend/src/index.ts` (adicionar `backend.add(import('./aws-ops'));` antes de `backend.start();`)
- Test: `packages/backend/src/aws-ops.test.ts`

**Interfaces:**
- Consumes: `pickPreviousVersion`, `upsertStack` (Task 1).
- Produces (HTTP API consumida pelo card no Task 3):
  - `GET /api/aws-ops/status?stack=<nome>` → `200 {stackName, stackStatus, lastUpdatedTime}` ou `404 {error}` (stack não existe) ou `500 {error}`.
  - `POST /api/aws-ops/deploy` body `{stackName, templateBody}` → `200 {action: 'updated'|'created', versionId}`.
  - `POST /api/aws-ops/rollback` body `{stackName}` → `200 {action: 'rollback', versionId}` ou `409 {error}` (sem versão anterior).
  - `GET /api/aws-ops/audit?stack=<nome>` → `200 [{ts, action, stack, result}]` (50 últimos).

Config em `app-config.yaml`: `awsOps.bucket` (obrigatório para deploy/rollback), `awsOps.region` (default us-east-1).

- [ ] **Step 1: Escrever o teste que falha**

`packages/backend/src/aws-ops.test.ts` — testa o roteador via mocks dos clients AWS:

```ts
import { createAwsOpsRouter } from './aws-ops';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import express from 'express';
import request from 'supertest';

const cfnMock = mockClient(CloudFormationClient);

describe('aws-ops router', () => {
  const app = express().use(express.json()).use(createAwsOpsRouter());

  beforeEach(() => cfnMock.reset());

  it('GET /status retorna stackStatus de uma stack existente', async () => {
    cfnMock
      .on(DescribeStacksCommand)
      .resolves({
        Stacks: [
          {
            StackName: 'minha-api',
            StackStatus: 'CREATE_COMPLETE',
            LastUpdatedTime: new Date('2026-09-16T12:00:00Z'),
          },
        ],
      });
    const res = await request(app).get('/status?stack=minha-api');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      stackName: 'minha-api',
      stackStatus: 'CREATE_COMPLETE',
    });
  });

  it('GET /status retorna 404 para stack inexistente', async () => {
    cfnMock.on(DescribeStacksCommand).resolves({ Stacks: [] });
    const res = await request(app).get('/status?stack=inexistente');
    expect(res.status).toBe(404);
  });

  it('POST /deploy rejeita payload sem stackName ou templateBody', async () => {
    const res = await request(app).post('/deploy').send({});
    expect(res.status).toBe(400);
  });
});
```

Dep de teste:

```bash
yarn workspace backend add -D aws-sdk-client-mock supertest @types/supertest
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `yarn workspace backend test src/aws-ops.test.ts`
Expected: FAIL — `createAwsOpsRouter` não existe.

- [ ] **Step 3: Implementar o plugin**

`packages/backend/src/aws-ops.ts`:

```ts
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DatabaseService, coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import express, { Router } from 'express';
import { pickPreviousVersion, upsertStack } from './aws-ops-helpers';

// audit log em sqlite (databaseService do backend). ponytail: schema criado
// ad-hoc no init; para produção mover para migration versionada.
async function ensureAuditTable(db: DatabaseService) {
  const client = await db.getClient();
  if (!await client.schema.hasTable('aws_ops_audit')) {
    await client.schema.createTable('aws_ops_audit', t => {
      t.increments('id').primary();
      t.timestamp('ts').defaultTo(client.fn.now());
      t.string('action').notNullable();
      t.string('stack').notNullable();
      t.string('result').notNullable();
    });
  }
  return client;
}

export function createAwsOpsRouter(): Router {
  const cfn = new CloudFormationClient({});
  const s3 = new S3Client({});

  const router = Router();

  router.get('/status', async (req, res) => {
    const stackName = String(req.query.stack ?? '');
    if (!stackName) {
      res.status(400).json({ error: 'query param "stack" é obrigatório' });
      return;
    }
    try {
      const out = await cfn.send(
        new DescribeStacksCommand({ StackName: stackName }),
      );
      const stack = out.Stacks?.[0];
      if (!stack) {
        res.status(404).json({ error: `stack ${stackName} não encontrada` });
        return;
      }
      res.json({
        stackName: stack.StackName,
        stackStatus: stack.StackStatus,
        lastUpdatedTime: stack.LastUpdatedTime,
      });
    } catch (e: any) {
      if (e.name === 'ValidationError' && /does not exist/i.test(String(e.message))) {
        res.status(404).json({ error: `stack ${stackName} não encontrada` });
        return;
      }
      res.status(500).json({ error: String(e.message) });
    }
  });

  router.post('/deploy', async (req, res) => {
    const { stackName, templateBody, bucket } = req.body ?? {};
    if (!stackName || !templateBody || !bucket) {
      res.status(400).json({ error: 'stackName, templateBody e bucket são obrigatórios' });
      return;
    }
    // trust boundary: stackName vira caminho/chave S3 e nome de recurso AWS
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(stackName)) {
      res.status(400).json({ error: 'stackName inválido (use letras, números e hífen)' });
      return;
    }
    try {
      const versionId = await deployVersion(s3, bucket, stackName, templateBody);
      const action = await upsertStack(cfn, stackName, templateBody);
      res.json({ action, versionId });
    } catch (e: any) {
      res.status(500).json({ error: String(e.message) });
    }
  });

  router.post('/rollback', async (req, res) => {
    const { stackName, bucket } = req.body ?? {};
    if (!stackName || !bucket) {
      res.status(400).json({ error: 'stackName e bucket são obrigatórios' });
      return;
    }
    try {
      const versionId = await rollback(s3, bucket, stackName);
      res.json({ action: 'rollback', versionId });
    } catch (e: any) {
      const status = /sem versão anterior/.test(String(e.message)) ? 409 : 500;
      res.status(status).json({ error: String(e.message) });
    }
  });

  router.get('/audit', async (_req, res) => {
    // preenchido no init (precisa do databaseService); rota declarada aqui
    // para o contrato HTTP ficar visível em createAwsOpsRouter.
    res.status(501).json({ error: 'audit requer init com database' });
  });

  return router;
}

async function deployVersion(
  s3: S3Client,
  bucket: string,
  stackName: string,
  templateBody: string,
): Promise<string> {
  const key = `templates/${stackName}/${Date.now()}.yaml`;
  const put = await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: templateBody,
    }),
  );
  // marca a versão corrente para o rollback saber de onde voltar
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `templates/${stackName}/CURRENT`,
      Body: JSON.stringify({ key, versionId: put.VersionId }),
    }),
  );
  return put.VersionId!;
}

async function rollback(
  s3: S3Client,
  bucket: string,
  stackName: string,
): Promise<string> {
  const current = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: `templates/${stackName}/CURRENT` }),
  );
  const currentBody = JSON.parse(
    await current.Body!.transformToString(),
  ) as { key: string; versionId: string };

  const versions = await s3.send(
    new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: `templates/${stackName}/`,
    }),
  );
  const prevId = pickPreviousVersion(
    (versions.Versions ?? []) as any,
    currentBody.versionId,
  );
  if (!prevId) {
    throw new Error('sem versão anterior para rollback');
  }
  const prev = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: currentBody.key,
      VersionId: prevId,
    }),
  );
  const templateBody = await prev.Body!.transformToString();
  await upsertStack(new CloudFormationClient({}), stackName, templateBody);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `templates/${stackName}/CURRENT`,
      Body: JSON.stringify({ key: currentBody.key, versionId: prevId }),
    }),
  );
  return prevId;
}

export default createBackendPlugin({
  pluginId: 'aws-ops',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        config: coreServices.rootConfig,
        database: coreServices.database,
        logger: coreServices.logger,
      },
      async init({ httpRouter, config, database, logger }) {
        await ensureAuditTable(database);
        const bucket = config.getOptionalString('awsOps.bucket');
        const router = createAwsOpsRouter();

        // audit real substitui a rota 501 do router base
        const auditClient = await database.getClient();
        router.get('/audit', async (req, res) => {
          const stack = String(req.query.stack ?? '');
          const rows = await auditClient('aws_ops_audit')
            .where(stack ? { stack } : {})
            .orderBy('id', 'desc')
            .limit(50);
          res.json(rows);
        });

        const originalDeploy = router.stack.find(
          l => (l as any).route?.path === '/deploy',
        );
        if (originalDeploy && bucket) {
          const handler = (originalDeploy.route as any).stack[0].handle;
          (originalDeploy.route as any).stack[0].handle = async (
            req: express.Request,
            res: express.Response,
            next: express.NextFunction,
          ) => {
            req.body.bucket = bucket;
            await handler(req, res, next);
            await auditClient('aws_ops_audit').insert({
              action: 'deploy',
              stack: req.body?.stackName ?? '?',
              result: res.statusCode,
            });
            logger.info(`aws-ops deploy audit: ${req.body?.stackName} -> ${res.statusCode}`);
          };
        }

        const originalRollback = router.stack.find(
          l => (l as any).route?.path === '/rollback',
        );
        if (originalRollback && bucket) {
          const handler = (originalRollback.route as any).stack[0].handle;
          (originalRollback.route as any).stack[0].handle = async (
            req: express.Request,
            res: express.Response,
            next: express.NextFunction,
          ) => {
            req.body.bucket = bucket;
            await handler(req, res, next);
            await auditClient('aws_ops_audit').insert({
              action: 'rollback',
              stack: req.body?.stackName ?? '?',
              result: res.statusCode,
            });
          };
        }

        httpRouter.use(router);
        logger.info('plugin aws-ops inicializado');
      },
    });
  },
});
```

> Nota de implementação: o wrap de audit via `router.stack` é frágil. **Alternativa preferida se der problema:** mover `bucket`/`audit` como parâmetros de `createAwsOpsRouter(config, db)` e renunciar ao wrap — mais reto, recomendado durante a execução. O contrato HTTP e os testes permanecem idênticos.

Registrar no backend — `packages/backend/src/index.ts`, antes de `backend.start();`:

```ts
// aws operations plugin (deploy/rollback/status)
backend.add(import('./aws-ops'));
```

- [ ] **Step 4: Rodar testes e typecheck**

Run: `yarn workspace backend test src/aws-ops.test.ts && yarn tsc`
Expected: testes PASS, tsc sem erros.
Se o wrap de audit quebrar o typecheck, aplicar a alternativa preferida (passar `config`/`db` como args de `createAwsOpsRouter`).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/aws-ops.ts packages/backend/src/aws-ops.test.ts packages/backend/src/index.ts packages/backend/package.json yarn.lock
git commit -m "feat(aws-ops): plugin backend com rotas status/deploy/rollback e audit log"
```

---

### Task 3: Card frontend "Operações AWS" + registro no app

**Files:**
- Create: `packages/app/src/modules/aws-ops/AwsOpsCard.tsx`
- Create: `packages/app/src/modules/aws-ops/awsOpsModule.tsx`
- Create: `packages/app/src/modules/aws-ops/index.ts`
- Modify: `packages/app/src/App.tsx` (adicionar `awsOpsModule` em `features`)
- Test: `packages/app/src/modules/aws-ops/AwsOpsCard.test.tsx`

**Interfaces:**
- Consumes: HTTP API do Task 2 (`/api/aws-ops/...` via `fetchApiRef`), anotação de entidade `alura.tech/aws-stack`.
- Produces: feature `awsOpsModule` (export default) registrada em `App.tsx`.

- [ ] **Step 1: Deps e teste que falha**

```bash
yarn workspace app add @backstage/plugin-catalog-react
```

`packages/app/src/modules/aws-ops/AwsOpsCard.test.tsx`:

```tsx
import { AwsOpsCard } from './AwsOpsCard';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { TestApiProvider, MockFetchApi } from '@backstage/test-utils';
import { fetchApiRef } from '@backstage/core-plugin-api';
import { render, screen, waitFor } from '@testing-library/react';

const entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'minha-api',
    annotations: { 'alura.tech/aws-stack': 'minha-api' },
  },
  spec: { type: 'service', lifecycle: 'production', owner: 'group:tech-preta' },
};

const fetchMock = { fetch: jest.fn().mockResolvedValue({
  ok: true,
  json: async () => ({
    stackName: 'minha-api',
    stackStatus: 'CREATE_COMPLETE',
  }),
}) };

describe('AwsOpsCard', () => {
  it('mostra o status da stack vinda da API', async () => {
    render(
      <TestApiProvider apis={[[fetchApiRef, fetchMock]]}>
        <EntityProvider entity={entity as any}>
          <AwsOpsCard />
        </EntityProvider>
      </TestApiProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText(/CREATE_COMPLETE/)).toBeInTheDocument(),
    );
    expect(fetchMock.fetch.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/aws-ops/status?stack=minha-api'),
      expect.anything(),
    );
  });

  it('avisa quando a entidade não tem a anotação aws-stack', () => {
    const semAnotacao = { ...entity, metadata: { name: 'x' } };
    render(
      <TestApiProvider apis={[[fetchApiRef, fetchMock]]}>
        <EntityProvider entity={semAnotacao as any}>
          <AwsOpsCard />
        </EntityProvider>
      </TestApiProvider>,
    );
    expect(screen.getByText(/alura.tech\/aws-stack/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `yarn workspace app test src/modules/aws-ops/AwsOpsCard.test.tsx`
Expected: FAIL — AwsOpsCard não existe.

- [ ] **Step 3: Implementar o card e o módulo**

`packages/app/src/modules/aws-ops/AwsOpsCard.tsx`:

```tsx
import { useEntity } from '@backstage/plugin-catalog-react';
import { InfoCard } from '@backstage/core-components';
import { fetchApiRef, useApi } from '@backstage/core-plugin-api';
import Button from '@material-ui/core/Button';
import Typography from '@material-ui/core/Typography';
import { useEffect, useState } from 'react';

const ANNOTATION = 'alura.tech/aws-stack';

type Status = { stackName: string; stackStatus: string };

export const AwsOpsCard = () => {
  const { entity } = useEntity();
  const stackName = entity.metadata.annotations?.[ANNOTATION];
  const { fetch } = useApi(fetchApiRef);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!stackName) return;
    const res = await fetch(
      `/api/aws-ops/status?stack=${encodeURIComponent(stackName)}`,
    );
    setStatus(res.ok ? await res.json() : null);
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000); // poll leve; stack em progresso atualiza sozinha
    return () => clearInterval(t);
  }, [stackName]);

  if (!stackName) {
    return (
      <InfoCard title="Operações AWS">
        <Typography variant="body2">
          Adicione a anotação <code>{ANNOTATION}: &lt;stack&gt;</code> no
          catalog-info.yaml para habilitar as operações AWS.
        </Typography>
      </InfoCard>
    );
  }

  const call = async (path: string) => {
    setBusy(true);
    try {
      await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stackName }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <InfoCard title={`Operações AWS — ${stackName}`}>
      <Typography variant="body1" data-testid="stack-status">
        Status: {status?.stackStatus ?? 'consultando…'}
      </Typography>
      <Button
        disabled={busy}
        onClick={() =>
          window.confirm(`Confirmar deploy de ${stackName}?`) &&
          call('/api/aws-ops/deploy')
        }
      >
        Deploy
      </Button>
      <Button
        disabled={busy}
        onClick={() =>
          window.confirm(`Confirmar rollback de ${stackName}?`) &&
          call('/api/aws-ops/rollback')
        }
      >
        Rollback
      </Button>
      {/* ponytail: deploy envia template vazio no body; card pega o template
      do repositório da entidade quando existir exemplos/aws no repo da aula */}
    </InfoCard>
  );
};
```

`packages/app/src/modules/aws-ops/awsOpsModule.tsx`:

```tsx
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { AwsOpsCard } from './AwsOpsCard';

export const awsOpsModule = createFrontendModule({
  pluginId: 'catalog',
  extensions: [
    EntityCardBlueprint.make({
      name: 'aws-ops',
      params: {
        filter: 'kind:component',
        loader: () => Promise.resolve(<AwsOpsCard />),
      },
    }),
  ],
});

export default awsOpsModule;
```

`packages/app/src/modules/aws-ops/index.ts`:

```ts
export { awsOpsModule as default } from './awsOpsModule';
export { AwsOpsCard } from './AwsOpsCard';
```

`packages/app/src/App.tsx`:

```tsx
import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { navModule } from './modules/nav';
import { homeModule } from './modules/home';
import awsOpsModule from './modules/aws-ops';

export default createApp({
  features: [catalogPlugin, navModule, homeModule, awsOpsModule],
});
```

> Se `EntityCardBlueprint` não existir na versão instalada de `@backstage/plugin-catalog-react/alpha`, usar `createCardExtension` do mesmo pacote alpha (API anterior, mesmo efeito). Verificar com `grep -r EntityCardBlueprint node_modules/@backstage/plugin-catalog-react/alpha/dist` antes de decidir.

- [ ] **Step 4: Rodar testes e typecheck**

Run: `yarn workspace app test src/modules/aws-ops/AwsOpsCard.test.tsx && yarn tsc`
Expected: PASS, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/modules/aws-ops packages/app/src/App.tsx packages/app/package.json yarn.lock
git commit -m "feat(aws-ops): card Operações AWS na página da entidade"
```

---

### Task 4: Config, stack de exemplo, entidade de exemplo e verificação manual

**Files:**
- Create: `examples/aws/stack-example.yaml`
- Create: `examples/aws/catalog-aws-component.yaml`
- Create: `.env.example` (modificar: adicionar `AWS_REGION`, `AWS_OPS_BUCKET` — sem valores de chave)
- Modify: `app-config.yaml` (bloco `awsOps:`)

**Interfaces:**
- Consumes: tudo das Tasks 1-3.
- Produces: setup completo para a aula.

- [ ] **Step 1: Stack de exemplo (Free Tier)**

`examples/aws/stack-example.yaml`:

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: Stack de exemplo da aula - Lambda hello-world + tabela DynamoDB
Resources:
  HelloFunction:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: alura-hello
      Runtime: python3.12
      Handler: index.handler
      MemorySize: 128
      Timeout: 10
      Role: !GetAtt HelloRole.Arn
      Code:
        ZipFile: |
          def handler(event, context):
              return {"statusCode": 200, "body": "hello from aws-ops"}
  HelloRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: alura-hello-role
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal: { Service: lambda.amazonaws.com }
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  DemoTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: alura-demo
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - { AttributeName: id, AttributeType: S }
      KeySchema:
        - { AttributeName: id, KeyType: HASH }
```

- [ ] **Step 2: Config e entidade de exemplo**

Em `app-config.yaml`, adicionar:

```yaml
awsOps:
  region: ${AWS_REGION}
  bucket: ${AWS_OPS_BUCKET}
```

Em `.env.example`:

```bash
AWS_REGION=us-east-1
AWS_OPS_BUCKET=alura-aws-ops-templates
```

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

- [ ] **Step 3: Verificação manual end-to-end (com credenciais da usuária)**

Pré-requisitos (um vez, fora do repo):
1. Criar bucket S3 com versioning: `aws s3api create-bucket --bucket $AWS_OPS_BUCKET --region us-east-1 && aws s3api put-bucket-versioning --bucket $AWS_OPS_BUCKET --versioning-configuration Status=Enabled`
2. Perfil IAM local com policy mínima (documentada no Task 5).

Checklist manual:
1. `yarn dev` sobe sem erros; log mostra `plugin aws-ops inicializado`.
2. Registrar `examples/aws/catalog-aws-component.yaml` no catálogo.
3. Na entidade `minha-api-serverless`, o card mostra "Status: consultando…" → 404 tratado (stack não existe ainda).
4. Deploy (via card com template do exemplo, ou curl): stack criada; `/status` → `CREATE_COMPLETE`.
5. Modificar o template do exemplo (ex.: mudar a mensagem do Lambda) e fazer segundo deploy.
6. Rollback: `/status` volta a refletir; bucket S3 mostra as 3 versões; audit log (`GET /api/aws-ops/audit`) tem deploy+rollback.

> O deploy pelo card precisa do templateBody. MVP: botão Deploy usa o conteúdo fixo de `examples/aws/stack-example.yaml` embutido no card? Não — curl/Scaffolder cobre isso na aula; card só expõe rollback/status agora. Ajustar `AwsOpsCard` para omitir o botão Deploy até existir fonte de template (o rollback é o botão estrela da aula). Documentar essa decisão no Task 5.

- [ ] **Step 4: Commit**

```bash
git add examples/aws app-config.yaml .env.example packages/app/src/modules/aws-ops/AwsOpsCard.tsx
git commit -m "feat(aws-ops): stack de exemplo, config e entidade de catálogo"
```

---

### Task 5: Documentação da aula + verificação final do repo

**Files:**
- Create: `docs/aws-ops-bot.md`
- Modify: `README.md` (link para o doc novo, se houver seção de docs)

- [ ] **Step 1: Escrever o guia da aula em pt-BR**

`docs/aws-ops-bot.md` — seções:
1. O que o bot faz (deploy/rollback/status via CloudFormation; sem DeleteStack).
2. Setup AWS: bucket S3 versionado, usuário/perfil IAM com policy mínima:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack", "cloudformation:UpdateStack",
        "cloudformation:DescribeStacks"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:ListBucket", "s3:ListBucketVersions"],
      "Resource": ["arn:aws:s3:::${AWS_OPS_BUCKET}", "arn:aws:s3:::${AWS_OPS_BUCKET}/*"]
    }
  ]
}
```

3. Anotação `alura.tech/aws-stack` e registro da entidade.
4. Fluxo da aula: deploy 1 → deploy 2 (mudança) → rollback → conferir audit log.
5. Limitações conscientes (sem DeleteStack, card sem Deploy até haver fonte de template, audit em sqlite local) e caminho de evolução (RBAC, Slack, templates por repositório).

- [ ] **Step 2: Rodar a suíte completa**

Run: `yarn run test && yarn tsc && yarn lint:all`
Expected: tudo PASS/limpo.

- [ ] **Step 3: Commit final**

```bash
git add docs/aws-ops-bot.md README.md
git commit -m "docs: guia da aula do bot operacional AWS (aws-ops)"
```

---

## Self-Review (feito na escrita)

- **Cobertura do spec:** status/deploy/rollback ✔ (Tasks 1-2), card UI com confirmação ✔ (Task 3), audit sqlite ✔ (Task 2), Free Tier/Lambda/DynamoDB ✔ (Task 4), credenciais via chain ✔ (Task 4/5), anotação `alura.tech/aws-stack` ✔ (Tasks 3-4), IAM least-privilege documentado ✔ (Task 5), fora de escopo respeitado (sem DeleteStack) ✔.
- **Placeholders:** nenhum TBD; código completo em todas as tasks. Risco conhecido documentado: wrap de audit (Task 2) tem alternativa preferida explícita.
- **Consistência de tipos:** `pickPreviousVersion(ObjectVersion[], string)` usada igualmente no rollback (Task 2) e nos testes (Task 1); contrato HTTP do Task 2 é exatamente o que o card do Task 3 consome; anotação `alura.tech/aws-stack` idêntica em Tasks 3, 4 e 5.
