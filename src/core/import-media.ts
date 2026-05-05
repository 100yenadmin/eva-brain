import { createHash } from 'crypto';
import type { BrainEngine } from './engine.ts';
import type { ChunkInput, PageInput } from './types.ts';
import { chunkText } from './chunkers/recursive.ts';
import { embedBatch } from './embedding.ts';
import { parseMarkdown, serializeMarkdown } from './markdown.ts';
import type { MediaEvidence } from './media-extraction.ts';

export interface MediaFileMetadata {
  filename?: string;
  mimeType?: string | null;
  sizeBytes?: number;
}

export interface ImportNormalizedMediaEvidenceOptions {
  slug: string;
  content: string;
  evidence: MediaEvidence;
  rawDataSource?: string;
  mediaFile?: MediaFileMetadata;
  pageTitle?: string;
  noEmbed?: boolean;
}

export interface ImportNormalizedMediaEvidenceResult {
  slug: string;
  status: 'imported' | 'skipped';
  rawDataSource: string;
  chunks: number;
}

export function defaultMediaContent(title: string, evidence: MediaEvidence): string {
  return serializeMarkdown({}, evidence.text, '', {
    type: 'media',
    title,
    tags: [],
  });
}

function chunkMediaPage(page: PageInput, evidence: MediaEvidence): ChunkInput[] {
  const parts = [page.compiled_truth, evidence.text]
    .map(part => part.trim())
    .filter(Boolean);
  const searchableText = Array.from(new Set(parts)).join('\n\n');
  return chunkText(searchableText).map((c, idx) => ({
    chunk_index: idx,
    chunk_text: c.text,
    chunk_source: 'compiled_truth',
  }));
}

function mediaEvidenceHash(page: PageInput, evidence: MediaEvidence): string {
  return createHash('sha256')
    .update(stableStringify({
      title: page.title,
      type: page.type,
      compiled_truth: page.compiled_truth,
      timeline: page.timeline || '',
      frontmatter: page.frontmatter || {},
      evidence,
    }))
    .digest('hex');
}

interface ParsedMediaPage {
  page: PageInput;
  tags: string[];
}

function parseMediaPageContent(content: string, slug: string, fallbackTitle: string, evidence: MediaEvidence): ParsedMediaPage {
  const parsed = parseMarkdown(content, `${slug}.md`);
  return {
    page: {
      title: parsed.title || fallbackTitle,
      type: 'media',
      compiled_truth: parsed.compiled_truth || evidence.text,
      timeline: parsed.timeline || '',
      frontmatter: {
        ...parsed.frontmatter,
        media_type: evidence.kind,
        source_ref: evidence.sourceRef,
        evidence_schema: evidence.schemaVersion,
        ingestion: 'media-evidence-mvp',
        media_tags: evidence.tags.map(tag => tag.value),
      },
    },
    tags: parsed.tags,
  };
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rawDataEqualsExisting(rows: Array<{ data: unknown }>, evidence: MediaEvidence): boolean {
  if (rows.length !== 1) return false;
  try {
    const existing = typeof rows[0]?.data === 'string'
      ? JSON.parse(rows[0].data as string)
      : rows[0]?.data;
    return stableStringify(existing) === stableStringify(evidence);
  } catch {
    return false;
  }
}

function pageMatchesExisting(existing: Awaited<ReturnType<BrainEngine['getPage']>>, page: PageInput): boolean {
  if (!existing) return false;
  return existing.content_hash === page.content_hash;
}

async function maybeEmbedChunks(chunks: ChunkInput[], noEmbed: boolean | undefined): Promise<void> {
  if (noEmbed || chunks.length === 0) return;
  const embeddings = await embedBatch(chunks.map(c => c.chunk_text));
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].embedding = embeddings[i];
    chunks[i].token_count = Math.ceil(chunks[i].chunk_text.length / 4);
  }
}

export async function importNormalizedMediaEvidence(
  engine: BrainEngine,
  opts: ImportNormalizedMediaEvidenceOptions,
): Promise<ImportNormalizedMediaEvidenceResult> {
  const pageTitle = opts.pageTitle || opts.evidence.sourceRef || opts.slug;
  if (!opts.evidence.text.trim()) throw new Error('Normalized media evidence text is empty.');

  const rawDataSource = opts.rawDataSource ?? 'gbrain.media-evidence.v1';
  const parsed = parseMediaPageContent(opts.content, opts.slug, pageTitle, opts.evidence);
  const page = parsed.page;
  page.frontmatter = {
    ...(page.frontmatter || {}),
    ...(opts.mediaFile?.filename ? { filename: opts.mediaFile.filename } : {}),
    ...(opts.mediaFile?.mimeType ? { mime_type: opts.mediaFile.mimeType } : {}),
    ...(opts.mediaFile?.sizeBytes !== undefined ? { size_bytes: opts.mediaFile.sizeBytes } : {}),
  };
  page.content_hash = mediaEvidenceHash(page, opts.evidence);

  const existing = await engine.getPage(opts.slug);
  const existingRawData = existing ? await engine.getRawData(opts.slug, rawDataSource) : [];
  const unchanged = pageMatchesExisting(existing, page) && rawDataEqualsExisting(existingRawData, opts.evidence);
  const chunks = chunkMediaPage(page, opts.evidence);

  if (unchanged) {
    return {
      slug: opts.slug,
      status: 'skipped',
      rawDataSource,
      chunks: chunks.length,
    };
  }

  await maybeEmbedChunks(chunks, opts.noEmbed);

  await engine.transaction(async (tx) => {
    if (existing) await tx.createVersion(opts.slug);
    await tx.putPage(opts.slug, page);
    await tx.putRawData(opts.slug, rawDataSource, opts.evidence as unknown as object);

    const existingTags = await tx.getTags(opts.slug);
    const newTags = new Set(parsed.tags);
    for (const old of existingTags) {
      if (!newTags.has(old)) await tx.removeTag(opts.slug, old);
    }
    for (const tag of parsed.tags) {
      await tx.addTag(opts.slug, tag);
    }

    if (chunks.length > 0) await tx.upsertChunks(opts.slug, chunks);
    else await tx.deleteChunks(opts.slug);
  });

  await engine.logIngest({
    source_type: 'media',
    source_ref: opts.evidence.sourceRef || opts.slug,
    pages_updated: [opts.slug],
    summary: `Imported normalized ${opts.evidence.kind} evidence for ${opts.slug}`,
  });

  return {
    slug: opts.slug,
    status: 'imported',
    rawDataSource,
    chunks: chunks.length,
  };
}
