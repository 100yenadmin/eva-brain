import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = new URL('..', import.meta.url).pathname;

async function runCli(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([process.execPath, 'run', 'src/cli.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
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
        '--slug', 'media/evidence/receipt',
        '--title', 'Custom Receipt Page',
      ], env);
      expect(result.code).toBe(0);
      const ingested = JSON.parse(result.stdout);
      expect(ingested.status).toBe('imported');
      expect(ingested.slug).toBe('media/evidence/receipt');

      result = await runCli(['search', 'Stripe'], env);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('media/evidence/receipt');
      expect(result.stdout).toContain('Stripe login error screenshot');

      result = await runCli(['search', 'Curated custom receipt narrative'], env);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('media/evidence/receipt');

      result = await runCli(['stats'], env);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Pages:     1');
      expect(result.stdout).toContain('Chunks:    1');
      expect(result.stdout).toContain('Embedded:  0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('ingest-media --extract openclaw sends image to gateway route and keeps evidence searchable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-media-openclaw-cli-'));
    const home = join(dir, 'home');
    const env = { HOME: home, GBRAIN_HOME: home };
    const mediaPath = join(dir, 'receipt.png');
    const requests: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        expect(new URL(req.url).pathname).toBe('/plugins/gbrain/extract');
        const body = await req.json();
        requests.push(body);
        return Response.json({
          ok: true,
          extraction: {
            schemaVersion: 'gbrain.media-extraction.v1',
            kind: 'image',
            sourceRef: body.sourceRef,
            title: 'OpenClaw Receipt',
            summary: 'Stripe login error screenshot with a receipt reference.',
            tags: ['receipt', 'stripe'],
            segments: [
              {
                id: 'frame-1',
                kind: 'frame',
                caption: 'Receipt screenshot',
                ocrText: 'Stripe login error screenshot',
              },
            ],
          },
        });
      },
    });

    try {
      writeFileSync(mediaPath, 'fake-image-binary');

      let result = await runCli(['init', '--pglite'], env);
      expect(result.code).toBe(0);

      result = await runCli([
        'ingest-media',
        mediaPath,
        '--extract', 'openclaw',
        '--slug', 'media/evidence/openclaw-receipt',
        '--title', 'OpenClaw Receipt',
        '--no-embed',
      ], {
        ...env,
        GBRAIN_OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${server.port}`,
        OPENAI_API_KEY: '',
        VOYAGE_API_KEY: '',
      });
      expect(result.code).toBe(0);
      const ingested = JSON.parse(result.stdout);
      expect(ingested.status).toBe('imported');
      expect(ingested.slug).toBe('media/evidence/openclaw-receipt');
      expect(ingested.no_embed).toBe(true);

      expect(requests).toHaveLength(1);
      const request = requests[0] as Record<string, any>;
      expect(request.kind).toBe('image');
      expect(request.file).toMatchObject({
        name: 'receipt.png',
        base64: Buffer.from('fake-image-binary').toString('base64'),
      });
      expect(JSON.stringify(request)).not.toMatch(/apiKey|OPENAI_API_KEY|refreshToken|oauth/i);

      result = await runCli(['search', 'Stripe'], env);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('media/evidence/openclaw-receipt');
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
