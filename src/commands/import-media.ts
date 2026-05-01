import { existsSync, readFileSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import { importMediaEvidence } from '../core/import-file.ts';
import { normalizeMediaExtraction, mediaExtractionToEvidence } from '../core/media-extraction.ts';

function usage(): never {
  console.error('Usage: gbrain import-media --slug <slug> --content-file <file.md> --extraction <file.json> [--source <name>] [--raw-data-source <name>] [--no-embed]');
  process.exit(1);
}

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

export async function runImportMedia(engine: BrainEngine, args: string[]) {
  const slug = getFlag(args, '--slug');
  const contentFile = getFlag(args, '--content-file');
  const extractionFile = getFlag(args, '--extraction');
  const source = getFlag(args, '--source');
  const rawDataSource = getFlag(args, '--raw-data-source');
  const noEmbed = args.includes('--no-embed');

  if (!slug || !contentFile || !extractionFile) usage();
  if (!existsSync(contentFile) || !existsSync(extractionFile)) usage();

  const content = readFileSync(contentFile, 'utf-8');
  const extractionJson = JSON.parse(readFileSync(extractionFile, 'utf-8')) as unknown;
  const extraction = normalizeMediaExtraction(extractionJson);
  const evidence = mediaExtractionToEvidence(extraction);

  const result = await importMediaEvidence(engine, slug, content, extraction, {
    noEmbed,
    source,
    rawDataSource,
  });

  console.log(JSON.stringify({
    status: result.status,
    slug: result.slug,
    chunks: result.chunks,
    raw_data_source: rawDataSource ?? source ?? 'media-extraction',
    segment_count: evidence.segments.length,
    evidence_text_length: evidence.text.length,
  }, null, 2));
}
