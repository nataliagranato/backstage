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
        Body: streamOf(JSON.stringify({ key: 't/main.tf', versionId: 'v2' })) as any,
      })
      .on(ListObjectVersionsCommand)
      .resolves({
        Versions: [{ VersionId: 'v2', IsLatest: true, LastModified: new Date() }],
      });
    const res = await request(app).post('/rollback').send({ stackName: 'minha-api' });
    expect(res.status).toBe(409);
  });
});
