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

// aws-sdk-client-mock devolve Readable puro (sem transformToString): fallback lê o stream
async function bodyOf(res: any): Promise<string> {
  if (typeof res.Body?.transformToString === 'function') {
    return res.Body.transformToString();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
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
