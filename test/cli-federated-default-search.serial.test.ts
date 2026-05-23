import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = new URL('..', import.meta.url).pathname;

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  delete childEnv.DATABASE_URL;
  delete childEnv.GBRAIN_DATABASE_URL;
  delete childEnv.GBRAIN_REMOTE_URL;
  delete childEnv.GBRAIN_SOURCE;

  const proc = Bun.spawn([process.execPath, 'run', 'src/cli.ts', ...args], {
    cwd: repoRoot,
    env: { ...childEnv, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe('local CLI federated default search', () => {
  test('seed-default local search reads federated sources instead of only the empty default source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-federated-default-'));
    const home = join(root, 'home');
    const source = join(root, 'support-kb');
    const env = { HOME: home, GBRAIN_HOME: home };

    try {
      mkdirSync(source, { recursive: true });
      writeFileSync(
        join(source, 'guide.md'),
        `---\ntitle: Support Guide\ntype: note\n---\n\nfederatedneedle support knowledge lives here.\n`,
      );

      let result = await runCli(['init', '--pglite', '--no-embedding'], env);
      expect(result.code).toBe(0);

      result = await runCli([
        'sources',
        'add',
        'support-kb',
        '--path',
        source,
        '--name',
        'Support KB',
        '--federated',
      ], env);
      expect(result.code).toBe(0);

      result = await runCli(['import', source, '--source', 'support-kb', '--no-embed'], env);
      expect(result.code).toBe(0);

      result = await runCli(['sources', 'current', '--json'], env);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        source_id: 'default',
        tier: 'seed_default',
      });

      result = await runCli(['search', 'federatedneedle', '--limit', '3'], env);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('guide');
      expect(result.stdout).toContain('federatedneedle support knowledge');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
