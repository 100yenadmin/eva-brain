import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runIngestMedia } from '../src/commands/import-media.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

describe('ingest-media normalized integration', () => {
  const engine = new PGLiteEngine();

  beforeAll(async () => {
    await engine.connect({});
    await engine.initSchema();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('routes ingest-media through normalized evidence and materializes page/raw_data/chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ingest-media-'));
    const mediaPath = join(dir, 'receipt.png');
    const extractionPath = join(dir, 'receipt.extraction.json');
    writeFileSync(mediaPath, 'fake-image-binary');
    writeFileSync(extractionPath, readFileSync(join(FIXTURES, 'media-extraction-image.json'), 'utf-8'));

    try {
      await runIngestMedia(engine, [
        mediaPath,
        '--extract', extractionPath,
        '--slug', 'media/evidence/receipt',
        '--title', 'Store receipt',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const page = await engine.getPage('media/evidence/receipt');
    expect(page).toBeTruthy();
    expect(page?.type).toBe('media');
    expect(page?.title).toBe('Store receipt');
    expect(page?.frontmatter.evidence_schema).toBe('gbrain.media-evidence.v1');
    expect(page?.frontmatter.media_type).toBe('image');
    expect(page?.compiled_truth).toContain('Stripe API key invalid');

    const raw = await engine.getRawData('media/evidence/receipt', 'gbrain.media-evidence.v1');
    expect(raw.length).toBe(1);
    const data = raw[0]?.data as any;
    expect(data.schemaVersion).toBe('gbrain.media-evidence.v1');
    expect(data.kind).toBe('image');
    expect(data.sourceRef).toContain('receipt.png');
    expect(data.segments.length).toBeGreaterThan(0);
    expect(data.segments[0].locator.bbox).toEqual([0.1, 0.2, 0.8, 0.35]);

    const chunks = await engine.getChunks('media/evidence/receipt');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some(c => c.chunk_text.includes('Stripe API key invalid'))).toBe(true);

    const filesTableAvailable = await engine.executeRaw<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='files') AS exists`,
    );
    if (!filesTableAvailable[0]?.exists) {
      expect(page?.frontmatter.filename).toBe('receipt.png');
      expect(page?.frontmatter.mime_type).toBe('image/png');
    }
  }, 30000);
});
