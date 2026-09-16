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
