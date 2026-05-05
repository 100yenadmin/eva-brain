import { describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = new URL('..', import.meta.url).pathname;

async function runCli(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([process.execPath, 'run', 'src/cli.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env, OPENAI_API_KEY: '', VOYAGE_API_KEY: '' },
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

describe('media evidence CLI smoke', () => {
  test('init -> import-media -> ingest-media -> search keeps media evidence searchable without embeddings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-media-cli-'));
    const home = join(dir, 'home');
    const env = { HOME: home, GBRAIN_HOME: home };
    const mediaPath = join(dir, 'receipt.png');
    const extractionPath = join(dir, 'receipt.extraction.json');
    const contentPath = join(dir, 'custom.md');

    try {
      writeFileSync(mediaPath, 'fake-image-binary');
      cpSync(join(repoRoot, 'test/fixtures/media-extraction-image.json'), extractionPath);
      writeFileSync(contentPath, `---\ntype: media\ntitle: Custom Receipt Page\ncustom_flag: preserved\n---\n\nCurated custom receipt narrative.\n`);

      let result = await runCli(['init', '--pglite'], env);
      expect(result.code).toBe(0);

      result = await runCli([
        'import-media',
        '--slug', 'media/evidence/receipt',
        '--content-file', contentPath,
        '--extraction', extractionPath,
        '--media-file', mediaPath,
        '--no-embed',
      ], env);
      expect(result.code).toBe(0);
      const imported = JSON.parse(result.stdout);
      expect(imported.status).toBe('imported');
      expect(imported.slug).toBe('media/evidence/receipt');
      expect(imported.raw_data_source).toBe('gbrain.media-evidence.v1');
      expect(imported.no_embed).toBe(true);

      result = await runCli([
        'ingest-media',
        mediaPath,
        '--extract', extractionPath,
        '--slug', 'media/evidence/receipt-ingested',
        '--title', 'Custom Receipt Page',
        '--no-embed',
      ], env);
      expect(result.code).toBe(0);
      const ingested = JSON.parse(result.stdout);
      expect(ingested.status).toBe('imported');
      expect(ingested.slug).toBe('media/evidence/receipt-ingested');

      result = await runCli(['search', 'Stripe'], env);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('media/evidence/receipt');
      expect(result.stdout).toContain('Stripe login error screenshot');

      result = await runCli(['search', 'Curated custom receipt narrative'], env);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('media/evidence/receipt');

      result = await runCli(['stats'], env);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Pages:     2');
      expect(result.stdout).toContain('Embedded:  0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
