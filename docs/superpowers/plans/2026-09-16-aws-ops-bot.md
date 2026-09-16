# Bot Operacional AWS (aws-ops) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Card "Operações AWS" na página da entidade do Backstage que executa deploy, rollback e status de infraestrutura Terraform/OpenTofu (Lambda + DynamoDB) na conta AWS, com templates versionados em S3 e audit log.

**Architecture:** Backend plugin `aws-ops` (arquivos em `packages/backend/src/aws-ops*.ts`, padrão do repo = verboo-actions.ts) com rotas HTTP `/status`, `/deploy`, `/rollback`, `/audit`. Deploy/rollback invocam a CLI **Terraform/OpenTofu** via `execFile` em workdir por stack (`/tmp/aws-ops/<stack>`), com state remoto no S3 (backend s3, key por stack) e templates HCL versionados no mesmo bucket. Frontend: módulo `packages/app/src/modules/aws-ops` com EntityCardBlueprint (novo frontend system, padrão do repo = modules/home).

**Tech Stack:** Backstage 1.54.0 (novo frontend system), `@aws-sdk/client-s3`, OpenTofu CLI (`tofu`, instalada em `/usr/bin/tofu`) ou Terraform (`awsOps.binary`), knex via `coreServices.database`, React + `@backstage/plugin-catalog-react/alpha` (EntityCardBlueprint), jest via `backstage-cli repo test`.

**Spec:** `docs/superpowers/specs/2026-09-16-aws-ops-bot-design.md`

## Global Constraints

- **Terraform/OpenTofu como mecanismo de deploy/rollback** (não CloudFormation). Binário configurável: `awsOps.binary` (default `terraform`; nesta máquina `tofu`). NUNCA usar shell string — sempre `execFile(bin, args)`.
- **Bootstrap do bucket de state**: o bucket S3 (state + templates versionados) é criado uma única vez por um módulo `examples/aws/bootstrap/` com state LOCAL (quebra o ovo-galinha), rodado manualmente via CLI. O bot nunca gerencia o próprio bucket.
- Sem `destroy` em qualquer rota (spec: fora de escopo — não existe botão de destruir infra).
- Nenhuma credencial AWS no repo — default credential chain (env/profile herdado pela CLI e pelo SDK).
- Documentação e comentários visíveis ao usuário em pt-BR.
- Yarn workspaces; testes com `yarn workspace backend test` / `yarn run test`; typecheck com `yarn tsc`.
- Ação mutante (deploy/rollback) sempre auditada; UI pede confirmação nativa (`window.confirm`).
- `stackName` validado com `/^[a-zA-Z0-9-]{1,100}$/` em toda rota que o recebe (vira workdir, chave S3 e key do state).

---

### Task 1: Helpers — versionamento S3 e wrapper da CLI (lógica + testes)

**Files:**
- Create: `packages/backend/src/aws-ops-helpers.ts`
- Test: `packages/backend/src/aws-ops-helpers.test.ts`

**Interfaces:**
- Consumes: nada (funções puras + child_process).
- Produces:
  - `pickPreviousVersion(versions: ObjectVersion[], currentId: string): string | undefined` — retorna VersionId do template HCL anterior ao `currentId`.
  - `runTerraform(binary: string, args: string[], workdir: string, timeoutMs?: number): Promise<{stdout: string; stderr: string}>` — `execFile` com timeout (default 300s) e `cwd=workdir`; rejeita com o stderr na mensagem.

- [ ] **Step 1: Escrever os testes que falham**

`packages/backend/src/aws-ops-helpers.test.ts`:

```ts
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pickPreviousVersion, runTerraform } from './aws-ops-helpers';

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

describe('runTerraform', () => {
  it('executa o binário no workdir e retorna stdout', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tf-test-'));
    // "binário" de teste: script shell que imprime o cwd
    const bin = path.join(dir, 'fake-tf');
    await fs.writeFile(bin, '#!/bin/sh\necho "workdir: $(pwd)"\n');
    await fs.chmod(bin, 0o755);

    const { stdout } = await runTerraform(bin, [], dir);
    expect(stdout).toBe(`workdir: ${dir}\n`);
  });

  it('propaga erro com stderr na mensagem quando o binário falha', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tf-test-'));
    const bin = path.join(dir, 'fake-tf-fail');
    await fs.writeFile(bin, '#!/bin/sh\necho "boom" >&2\nexit 1\n');
    await fs.chmod(bin, 0o755);

    await expect(runTerraform(bin, [], dir)).rejects.toThrow(/boom/);
  });

  it('estoura timeout quando o binário travar', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tf-test-'));
    const bin = path.join(dir, 'fake-tf-slow');
    await fs.writeFile(bin, '#!/bin/sh\nsleep 5\n');
    await fs.chmod(bin, 0o755);

    await expect(runTerraform(bin, [], dir, 200)).rejects.toThrow();
  }, 10_000);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `yarn workspace backend test src/aws-ops-helpers.test.ts`
Expected: FAIL — módulo `./aws-ops-helpers` não existe.

- [ ] **Step 3: Implementar os helpers**

`packages/backend/src/aws-ops-helpers.ts`:

```ts
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
    .sort((a, b) => b.LastModified!.getTime() - a.LastModified!.getTime());
  return older[0]?.VersionId;
}

export async function runTerraform(
  binary: string,
  args: string[],
  workdir: string,
  timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(binary, args, {
      cwd: workdir,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e: any) {
    // devolve stderr na mensagem para o card/audit exibirem o erro real da CLI
    const stderr = e?.stderr || e?.message || String(e);
    throw new Error(`falha na CLI (${binary} ${args.join(' ')}): ${stderr}`);
  }
}
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `yarn workspace backend test src/aws-ops-helpers.test.ts`
Expected: PASS (7 testes).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/aws-ops-helpers.ts packages/backend/src/aws-ops-helpers.test.ts
git commit -m "feat(aws-ops): helpers de versionamento S3 e wrapper da CLI terraform/tofu"
```

---

### Task 2: Plugin backend aws-ops (rotas status/deploy/rollback + audit log)

**Files:**
- Create: `packages/backend/src/aws-ops.ts`
- Modify: `packages/backend/src/index.ts` (adicionar `backend.add(import('./aws-ops'));` antes de `backend.start();`)
- Test: `packages/backend/src/aws-ops.test.ts`

**Interfaces:**
- Consumes: `pickPreviousVersion`, `runTerraform` (Task 1).
- Produces (HTTP API consumida pelo card no Task 3):
  - `GET /api/aws-ops/status?stack=<nome>` → `200 {stack, outputs}` ou `404 {error}` (não provisionada) ou `400 {error}`.
  - `POST /api/aws-ops/deploy` body `{stackName, templateBody}` → `200 {action: 'deploy', versionId}` ou `400/500 {error}`.
  - `POST /api/aws-ops/rollback` body `{stackName}` → `200 {action: 'rollback', versionId}` ou `409 {error}` (sem versão anterior).
  - `GET /api/aws-ops/audit?stack=<nome>` → `200 [{id, ts, action, stack, result}]` (50 últimos).

Config em `app-config.yaml`: `awsOps.binary` (default `terraform`), `awsOps.bucket` (obrigatório), `awsOps.region` (default us-east-1). Implementação usa `createAwsOpsRouter(opts)` com dependências injetadas (sem wrap de rotas).

- [ ] **Step 1: Deps + teste que falha**

```bash
yarn workspace backend add @aws-sdk/client-s3
yarn workspace backend add -D aws-sdk-client-mock
```

`packages/backend/src/aws-ops.test.ts`:

```ts
import { createAwsOpsRouter } from './aws-ops';
import { mockClient } from 'aws-sdk-client-mock';
import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import express from 'express';
import request from 'supertest';

const s3Mock = mockClient(S3Client);

// stub da CLI: nenhum teste toca o tofu real
jest.mock('./aws-ops-helpers', () => {
  const actual = jest.requireActual('./aws-ops-helpers');
  return {
    ...actual,
    runTerraform: jest.fn().mockResolvedValue({ stdout: '{}', stderr: '' }),
  };
});
import { runTerraform } from './aws-ops-helpers';

const streamOf = (body: string) => Readable.from([body]);

describe('aws-ops router', () => {
  const app = express().use(express.json()).use(
    createAwsOpsRouter({
      bucket: 'test-bucket',
      region: 'us-east-1',
      binary: 'terraform',
      db: null,
    }),
  );

  beforeEach(() => {
    s3Mock.reset();
    (runTerraform as jest.Mock).mockClear();
    (runTerraform as jest.Mock).mockResolvedValue({ stdout: '{}', stderr: '' });
  });

  it('POST /deploy rejeita payload sem stackName ou templateBody', async () => {
    const res = await request(app).post('/deploy').send({});
    expect(res.status).toBe(400);
  });

  it('POST /deploy rejeita stackName inválido', async () => {
    const res = await request(app)
      .post('/deploy')
      .send({ stackName: '../evil', templateBody: 'resource {}' });
    expect(res.status).toBe(400);
  });

  it('GET /status sem query stack retorna 400', async () => {
    const res = await request(app).get('/status');
    expect(res.status).toBe(400);
  });

  it('POST /rollback retorna 409 quando não há versão anterior', async () => {
    s3Mock
      .on(GetObjectCommand)
      .resolves({
        Body: streamOf(JSON.stringify({ key: 't/main.tf', versionId: 'v2' })),
      })
      .on(ListObjectVersionsCommand)
      .resolves({
        Versions: [{ VersionId: 'v2', IsLatest: true, LastModified: new Date() }],
      });
    const res = await request(app).post('/rollback').send({ stackName: 'minha-api' });
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `yarn workspace backend test src/aws-ops.test.ts`
Expected: FAIL — `createAwsOpsRouter` não existe.

- [ ] **Step 3: Implementar o plugin**

`packages/backend/src/aws-ops.ts`:

```ts
import { createBackendPlugin, coreServices } from '@backstage/backend-plugin-api';
import { Router } from 'express';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { pickPreviousVersion, runTerraform } from './aws-ops-helpers';

const STACK_RE = /^[a-zA-Z0-9-]{1,100}$/;

type Opts = {
  bucket: string;
  region: string;
  binary: string;
  db: any; // knex client; nos testes é null (audit fica inerte)
};

async function bodyOf(res: any): Promise<string> {
  return res.Body.transformToString();
}

async function ensureAuditTable(db: any) {
  if (!db) return;
  if (!(await db.schema.hasTable('aws_ops_audit'))) {
    await db.schema.createTable('aws_ops_audit', (t: any) => {
      t.increments('id').primary();
      t.timestamp('ts').defaultTo(db.fn.now());
      t.string('action').notNullable();
      t.string('stack').notNullable();
      t.string('result').notNullable();
    });
  }
}

async function audit(db: any, action: string, stack: string, result: string) {
  if (!db) return;
  await db('aws_ops_audit').insert({ action, stack, result });
}

// backend.tf + provider.tf gerados pelo bot; o template do usuário só tem resources
async function writeWorkdir(
  opts: Opts,
  stackName: string,
  templateBody: string,
): Promise<string> {
  const workdir = path.join(os.tmpdir(), 'aws-ops', stackName);
  await fs.mkdir(workdir, { recursive: true });
  await fs.writeFile(
    path.join(workdir, 'backend.tf'),
    `terraform {\n  backend "s3" {\n    bucket = "${opts.bucket}"\n    key    = "states/${stackName}.tfstate"\n    region = "${opts.region}"\n  }\n}\n`,
  );
  await fs.writeFile(
    path.join(workdir, 'provider.tf'),
    `provider "aws" {\n  region = "${opts.region}"\n}\n`,
  );
  await fs.writeFile(path.join(workdir, 'main.tf'), templateBody);
  return workdir;
}

async function deploy(
  opts: Opts,
  stackName: string,
  templateBody: string,
): Promise<{ action: string; versionId: string }> {
  const client = new S3Client({ region: opts.region });
  const workdir = await writeWorkdir(opts, stackName, templateBody);

  await runTerraform(opts.binary, ['init', '-input=false', '-no-color'], workdir);
  await runTerraform(
    opts.binary,
    ['apply', '-auto-approve', '-input=false', '-no-color'],
    workdir,
  );

  // versiona o template no bucket e move o ponteiro CURRENT
  const key = `templates/${stackName}/${Date.now()}.tf`;
  const put = await client.send(
    new PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: templateBody }),
  );
  await client.send(
    new PutObjectCommand({
      Bucket: opts.bucket,
      Key: `templates/${stackName}/CURRENT`,
      Body: JSON.stringify({ key, versionId: put.VersionId }),
    }),
  );
  return { action: 'deploy', versionId: put.VersionId! };
}

async function rollback(
  opts: Opts,
  stackName: string,
): Promise<{ action: string; versionId: string }> {
  const client = new S3Client({ region: opts.region });

  const current = await client.send(
    new GetObjectCommand({ Bucket: opts.bucket, Key: `templates/${stackName}/CURRENT` }),
  );
  const cur = JSON.parse(await bodyOf(current)) as { key: string; versionId: string };

  const versions = await client.send(
    new ListObjectVersionsCommand({ Bucket: opts.bucket, Prefix: `templates/${stackName}/` }),
  );
  const prevId = pickPreviousVersion((versions.Versions ?? []) as any, cur.versionId);
  if (!prevId) {
    throw Object.assign(new Error('sem versão anterior para rollback'), {
      statusCode: 409,
    });
  }
  const prev = await client.send(
    new GetObjectCommand({ Bucket: opts.bucket, Key: cur.key, VersionId: prevId }),
  );
  const templateBody = await bodyOf(prev);

  const workdir = await writeWorkdir(opts, stackName, templateBody);
  await runTerraform(opts.binary, ['init', '-input=false', '-no-color'], workdir);
  await runTerraform(
    opts.binary,
    ['apply', '-auto-approve', '-input=false', '-no-color'],
    workdir,
  );

  await client.send(
    new PutObjectCommand({
      Bucket: opts.bucket,
      Key: `templates/${stackName}/CURRENT`,
      Body: JSON.stringify({ key: cur.key, versionId: prevId }),
    }),
  );
  return { action: 'rollback', versionId: prevId };
}

export function createAwsOpsRouter(opts: Opts): Router {
  const router = Router();

  router.get('/status', async (req, res) => {
    const stackName = String(req.query.stack ?? '');
    if (!STACK_RE.test(stackName)) {
      res.status(400).json({
        error: 'query param "stack" é obrigatório (letras, números e hífen)',
      });
      return;
    }
    const workdir = path.join(os.tmpdir(), 'aws-ops', stackName);
    try {
      const { stdout } = await runTerraform(
        opts.binary,
        ['output', '-json', '-no-color'],
        workdir,
        30_000,
      );
      res.json({ stack: stackName, outputs: JSON.parse(stdout || '{}') });
    } catch {
      res
        .status(404)
        .json({ error: `stack ${stackName} não provisionada (sem state local)` });
    }
  });

  router.post('/deploy', async (req, res) => {
    const { stackName, templateBody } = req.body ?? {};
    if (!stackName || !templateBody || !STACK_RE.test(stackName)) {
      res
        .status(400)
        .json({ error: 'stackName (letras/números/hífen) e templateBody são obrigatórios' });
      return;
    }
    try {
      const out = await deploy(opts, stackName, String(templateBody));
      await audit(opts.db, 'deploy', stackName, String(res.statusCode));
      res.json(out);
    } catch (e: any) {
      await audit(opts.db, 'deploy', stackName, `erro: ${String(e.message).slice(0, 200)}`);
      res.status(500).json({ error: String(e.message) });
    }
  });

  router.post('/rollback', async (req, res) => {
    const { stackName } = req.body ?? {};
    if (!stackName || !STACK_RE.test(stackName)) {
      res
        .status(400)
        .json({ error: 'stackName (letras/números/hífen) é obrigatório' });
      return;
    }
    try {
      const out = await rollback(opts, stackName);
      await audit(opts.db, 'rollback', stackName, String(res.statusCode));
      res.json(out);
    } catch (e: any) {
      await audit(opts.db, 'rollback', stackName, `erro: ${String(e.message).slice(0, 200)}`);
      res.status(e?.statusCode ?? 500).json({ error: String(e.message) });
    }
  });

  router.get('/audit', async (req, res) => {
    if (!opts.db) {
      res.status(501).json({ error: 'audit indisponível sem database' });
      return;
    }
    const stack = String(req.query.stack ?? '');
    const rows = await opts
      .db('aws_ops_audit')
      .where(stack ? { stack } : {})
      .orderBy('id', 'desc')
      .limit(50);
    res.json(rows);
  });

  return router;
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
        const bucket = config.getString('awsOps.bucket');
        const region = config.getOptionalString('awsOps.region') ?? 'us-east-1';
        const binary = config.getOptionalString('awsOps.binary') ?? 'terraform';
        const db = await database.getClient();
        await ensureAuditTable(db);
        httpRouter.use(createAwsOpsRouter({ bucket, region, binary, db }));
        logger.info(`plugin aws-ops inicializado (binário: ${binary}, bucket: ${bucket})`);
      },
    });
  },
});
```

Registrar em `packages/backend/src/index.ts` (antes de `backend.start();`):

```ts
// aws operations plugin (deploy/rollback/status via terraform/tofu)
backend.add(import('./aws-ops'));
```

- [ ] **Step 4: Rodar testes e typecheck**

Run: `yarn workspace backend test src/aws-ops.test.ts src/aws-ops-helpers.test.ts && yarn tsc`
Expected: PASS, tsc sem erros.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/aws-ops.ts packages/backend/src/aws-ops.test.ts packages/backend/src/index.ts packages/backend/package.json yarn.lock
git commit -m "feat(aws-ops): plugin backend terraform deploy/rollback/status com audit"
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

- [ ] **Step 1: Teste que falha**

`packages/app/src/modules/aws-ops/AwsOpsCard.test.tsx`:

```tsx
import { AwsOpsCard } from './AwsOpsCard';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { TestApiProvider } from '@backstage/test-utils';
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

const fetchMock = {
  fetch: jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ stack: 'minha-api', outputs: {} }),
  }),
};

describe('AwsOpsCard', () => {
  it('consulta o status da API ao renderizar', async () => {
    render(
      <TestApiProvider apis={[[fetchApiRef, fetchMock]]}>
        <EntityProvider entity={entity as any}>
          <AwsOpsCard />
        </EntityProvider>
      </TestApiProvider>,
    );
    await waitFor(() =>
      expect(fetchMock.fetch.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/aws-ops/status?stack=minha-api'),
      ),
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

export const AwsOpsCard = () => {
  const { entity } = useEntity();
  const stackName = entity.metadata.annotations?.[ANNOTATION];
  const { fetch } = useApi(fetchApiRef);
  const [status, setStatus] = useState<string>('consultando…');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!stackName) return;
    const res = await fetch(
      `/api/aws-ops/status?stack=${encodeURIComponent(stackName)}`,
    );
    setStatus(res.ok ? 'provisionada' : 'não provisionada');
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000); // poll leve; apply em progresso aparece sozinho
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
        Status: {status}
      </Typography>
      <Typography variant="body2" color="textSecondary">
        O template HCL é enviado via API/Scaffolder; o card executa rollback e
        consulta status.
      </Typography>
      <Button
        disabled={busy}
        onClick={() =>
          window.confirm(`Confirmar rollback de ${stackName}?`) &&
          call('/api/aws-ops/rollback')
        }
      >
        Rollback
      </Button>
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

> Se `EntityCardBlueprint` não existir na versão instalada de `@backstage/plugin-catalog-react/alpha`, verificar com `grep -r EntityCardBlueprint node_modules/@backstage/plugin-catalog-react/alpha/dist` e usar a API equivalente disponível (ex.: `createCardExtension`).

- [ ] **Step 4: Rodar testes e typecheck**

Run: `yarn workspace app test src/modules/aws-ops/AwsOpsCard.test.tsx && yarn tsc`
Expected: PASS, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/modules/aws-ops packages/app/src/App.tsx
git commit -m "feat(aws-ops): card Operações AWS na página da entidade"
```

---

### Task 4: Bootstrap do bucket de state + stack de exemplo + config

**Files:**
- Create: `examples/aws/bootstrap/main.tf` (cria o bucket versionado; state LOCAL — roda uma vez)
- Create: `examples/aws/stack-example.tf` (template HCL que o bot aplica)
- Create: `examples/aws/catalog-aws-component.yaml`
- Modify: `app-config.yaml` (bloco `awsOps:`)
- Modify: `.env.example` (adicionar `AWS_REGION`, `AWS_OPS_BUCKET`, `TF_BINARY`)

**Interfaces:**
- Consumes: nada do bot (infrastructure-only).
- Produces: bucket `${AWS_OPS_BUCKET}` com versioning ativo — usado pelo backend s3 do bot (Task 2) e como arquivo dos templates versionados.

- [ ] **Step 1: Módulo bootstrap (state local, roda 1x)**

`examples/aws/bootstrap/main.tf`:

```hcl
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
```

> **Atenção (blast radius):** o `apply` acima cria 1 bucket S3 na conta — efeito limitado e reversível (`destroy` derruba SOMENTE este bucket). Não gerencia mais nada.

- [ ] **Step 2: Stack de exemplo (Free Tier)**

`examples/aws/stack-example.tf` — este arquivo é o **templateBody** que o bot aplica (via API/Scaffolder):

```hcl
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
    content = <<PY
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
```

- [ ] **Step 3: Config e entidade de exemplo**

Em `app-config.yaml`:

```yaml
awsOps:
  binary: ${TF_BINARY}
  bucket: ${AWS_OPS_BUCKET}
  region: ${AWS_REGION}
```

Em `.env.example`:

```bash
AWS_REGION=us-east-1
AWS_OPS_BUCKET=alura-aws-ops-templates
TF_BINARY=tofu
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

- [ ] **Step 4: Validar sintaxe HCL (sem aplicar nada)**

```bash
TF=$(command -v terraform || command -v tofu)
cd examples/aws/bootstrap && $TF init -backend=false && $TF validate
# para a stack de exemplo, copiar para um dir temporário (o data/archive precisa do provider aws):
TF=$(command -v terraform || command -v tofu)
TMP=$(mktemp -d) && cp examples/aws/stack-example.tf $TMP/ && cd $TMP && $TF init -backend=false && $TF validate
```

Expected: `Success! The configuration is valid.` nos dois.

- [ ] **Step 5: Commit**

```bash
git add examples/aws app-config.yaml .env.example
git commit -m "feat(aws-ops): bootstrap do bucket de state, stack de exemplo e config"
```

---

### Task 5: Documentação da aula + verificação final do repo

**Files:**
- Create: `docs/aws-ops-bot.md`

- [ ] **Step 1: Escrever o guia da aula em pt-BR**

`docs/aws-ops-bot.md` — seções:
1. O que o bot faz (deploy/rollback/status via Terraform/OpenTofu; sem destroy).
2. **Setup AWS (uma vez):**
   - Bootstrap do bucket: `cd examples/aws/bootstrap && terraform init && terraform apply -var="bucket=SEU_BUCKET"` (state local de propósito; ~2 recursos: bucket + versioning).
   - Credenciais no `.env` (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`) — herdadas pela CLI tofu e pelo SDK.
   - Policy IAM mínima (least-privilege, didática):

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

3. Anotação `alura.tech/aws-stack` e registro da entidade no catálogo.
4. Fluxo da aula: deploy 1 (`curl -X POST /api/aws-ops/deploy -H 'Content-Type: application/json' -d "{\"stackName\":\"minha-api-serverless\",\"templateBody\":\"$(cat examples/aws/stack-example.tf)\"}"`) → deploy 2 (mudar a mensagem do Lambda) → rollback pelo card → conferir audit log (`GET /api/aws-ops/audit`).
5. Limitações conscientes (sem destroy; card só rollback/status; audit em sqlite local; workdir em /tmp; sem lock de state — um apply por vez) e caminho de evolução (RBAC, Slack, DynamoDB lock, templates por repositório, Scaffolder action `awsOps:deploy`).

- [ ] **Step 2: Rodar a suíte completa**

Run: `yarn run test && yarn tsc && yarn lint:all`
Expected: tudo PASS/limpo.

- [ ] **Step 3: Commit final**

```bash
git add docs/aws-ops-bot.md
git commit -m "docs: guia da aula do bot operacional AWS (aws-ops)"
```

---

## Self-Review (feito na escrita)

- **Cobertura do spec:** deploy/rollback/status via Terraform/OpenTofu ✔ (Tasks 1-2), **bucket bootstrap com state local** ✔ (Task 4), card UI com confirmação ✔ (Task 3), audit sqlite ✔ (Task 2), Free Tier/Lambda/DynamoDB ✔ (Task 4), credenciais via chain ✔ (Task 5), anotação `alura.tech/aws-stack` ✔ (Tasks 3-5), IAM least-privilege ✔ (Task 5), sem destroy ✔ (Global Constraints).
- **Placeholders:** nenhum TBD; código completo em todas as tasks.
- **Consistência de tipos:** `pickPreviousVersion(ObjectVersion[], string)` igual em Task 1 (def) e Task 2 (uso no rollback); `runTerraform(binary, args, workdir, timeoutMs?)` igual em Tasks 1-2; contrato HTTP do Task 2 = consumo do card no Task 3; `awsOps.binary/bucket/region` idênticos em Task 2 (leitura), Task 4 (config) e Task 5 (guia).
