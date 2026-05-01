import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ingestMediaEvidence } from '../src/commands/files.ts';

async function makeEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-media-ingest-'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dir });
  await engine.initSchema();
  return { engine, dir };
}

describe('ingestMediaEvidence', () => {
  test('creates media page, raw_data, file record, and searchable text', async () => {
    const { engine, dir } = await makeEngine();
    try {
      const mediaPath = join(dir, 'receipt.png');
      const extractionPath = join(dir, 'receipt.extraction.json');
      writeFileSync(mediaPath, 'fake-image-binary');
      writeFileSync(extractionPath, JSON.stringify({
        caption: 'Receipt on wooden table',
        ocr_text: 'Total: $42.50\nMerchant: Example Store',
        transcript: '',
      }));

      const result = await ingestMediaEvidence(engine, {
        path: mediaPath,
        extractionPath,
        slug: 'media/evidence/receipt',
        title: 'Store receipt',
        source: 'fixture-extractor',
      });

      expect(result.slug).toBe('media/evidence/receipt');
      expect(result.fileAttached).toBe(false);
      expect(result.storagePath).toBe('media/evidence/receipt/receipt.png');

      const page = await engine.getPage('media/evidence/receipt');
      expect(page).toBeTruthy();
      expect(page?.type).toBe('media');
      expect(page?.title).toBe('Store receipt');
      expect(page?.compiled_truth).toContain('Receipt on wooden table');
      expect(page?.compiled_truth).toContain('Total: $42.50');
      expect(page?.frontmatter.media_type).toBe('image');

      const raw = await engine.getRawData('media/evidence/receipt', 'fixture-extractor');
      expect(raw.length).toBe(1);
      expect((raw[0].data as any).extraction.ocr_text).toContain('Total: $42.50');

      const chunks = await engine.getChunks('media/evidence/receipt');
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some(c => c.chunk_text.includes('Example Store'))).toBe(true);
      expect(result.storagePath).toBe('media/evidence/receipt/receipt.png');
    } finally {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('fails when extraction has no searchable text', async () => {
    const { engine, dir } = await makeEngine();
    try {
      const mediaPath = join(dir, 'empty.pdf');
      const extractionPath = join(dir, 'empty.extraction.json');
      writeFileSync(mediaPath, 'fake-pdf-binary');
      writeFileSync(extractionPath, JSON.stringify({ pages: [{ width: 100, height: 100 }] }));

      await expect(ingestMediaEvidence(engine, {
        path: mediaPath,
        extractionPath,
      })).rejects.toThrow('Extraction JSON did not contain searchable text');
    } finally {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
