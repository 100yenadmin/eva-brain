import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runIngestMedia } from '../src/commands/import-media.ts';

describe('ingest-media OpenClaw env-sensitive guards', () => {
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

  test('rejects binary PDF extraction until PDF text extraction is implemented', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ingest-media-pdf-'));
    const mediaPath = join(dir, 'document.pdf');
    const prevCommand = process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND;
    writeFileSync(mediaPath, '%PDF-1.7\nbinary-ish content');
    process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND = 'cat';

    try {
      await expect(runIngestMedia(engine, [
        mediaPath,
        '--extract', 'openclaw',
        '--slug', 'media/evidence/document',
      ])).rejects.toThrow('text-backed PDF content today');
    } finally {
      if (prevCommand === undefined) delete process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND;
      else process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND = prevCommand;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('rejects unknown binary document types for OpenClaw extraction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ingest-media-docx-'));
    const mediaPath = join(dir, 'document.docx');
    const prevCommand = process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND;
    writeFileSync(mediaPath, 'fake-docx-binary');
    process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND = 'cat';

    try {
      await expect(runIngestMedia(engine, [
        mediaPath,
        '--extract', 'openclaw',
        '--slug', 'media/evidence/document',
      ])).rejects.toThrow('does not support .docx files yet');
    } finally {
      if (prevCommand === undefined) delete process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND;
      else process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND = prevCommand;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('requires the OpenClaw gateway for image extraction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ingest-media-image-command-'));
    const mediaPath = join(dir, 'receipt.png');
    const prevCommand = process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND;
    const prevGatewayUrl = process.env.GBRAIN_OPENCLAW_GATEWAY_URL;
    const prevOpenClawGatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
    writeFileSync(mediaPath, 'fake-image-binary');
    process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND = 'cat';
    delete process.env.GBRAIN_OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_URL;

    try {
      await expect(runIngestMedia(engine, [
        mediaPath,
        '--extract', 'openclaw',
        '--slug', 'media/evidence/receipt',
      ])).rejects.toThrow('image extraction requires GBRAIN_OPENCLAW_GATEWAY_URL');
    } finally {
      if (prevCommand === undefined) delete process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND;
      else process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND = prevCommand;
      if (prevGatewayUrl === undefined) delete process.env.GBRAIN_OPENCLAW_GATEWAY_URL;
      else process.env.GBRAIN_OPENCLAW_GATEWAY_URL = prevGatewayUrl;
      if (prevOpenClawGatewayUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
      else process.env.OPENCLAW_GATEWAY_URL = prevOpenClawGatewayUrl;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('rejects oversized image inputs before base64 encoding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ingest-media-large-image-'));
    const mediaPath = join(dir, 'large.png');
    const prevGatewayUrl = process.env.GBRAIN_OPENCLAW_GATEWAY_URL;
    writeFileSync(mediaPath, Buffer.alloc(10_000_001));
    process.env.GBRAIN_OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:1';

    try {
      await expect(runIngestMedia(engine, [
        mediaPath,
        '--extract', 'openclaw',
        '--slug', 'media/evidence/large',
      ])).rejects.toThrow('only supports image inputs up to 10000000 bytes');
    } finally {
      if (prevGatewayUrl === undefined) delete process.env.GBRAIN_OPENCLAW_GATEWAY_URL;
      else process.env.GBRAIN_OPENCLAW_GATEWAY_URL = prevGatewayUrl;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
