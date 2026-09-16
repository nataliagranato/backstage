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
