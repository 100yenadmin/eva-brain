export type MediaExtractionKind = 'image' | 'pdf' | 'video' | 'audio';

export type MediaSegmentKind = 'asset' | 'page' | 'frame' | 'transcript_segment' | 'audio_segment';

export interface MediaLocator {
  page?: number;
  pageLabel?: string;
  frame?: number;
  timecode?: string;
  startMs?: number;
  endMs?: number;
  bbox?: [number, number, number, number];
  timestamp?: string;
}

export interface MediaEntity {
  text: string;
  type?: string;
  confidence?: number;
}

export interface MediaTag {
  value: string;
  confidence?: number;
}

export interface MediaMatchReason {
  kind: 'ocr' | 'caption' | 'summary' | 'transcript' | 'entity' | 'tag' | 'visual' | 'metadata' | 'other';
  detail: string;
  confidence?: number;
}

export interface MediaExtractionSegment {
  id: string;
  kind: MediaSegmentKind;
  locator?: MediaLocator;
  caption?: string;
  summary?: string;
  ocrText?: string;
  transcriptText?: string;
  entities?: MediaEntity[];
  tags?: MediaTag[];
  matchReasons?: MediaMatchReason[];
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface MediaExtraction {
  schemaVersion: 'gbrain.media-extraction.v1';
  kind: MediaExtractionKind;
  sourceRef?: string;
  title?: string;
  summary?: string;
  caption?: string;
  ocrText?: string;
  transcriptText?: string;
  segments: MediaExtractionSegment[];
  entities?: MediaEntity[];
  tags?: MediaTag[];
  matchReasons?: MediaMatchReason[];
  metadata?: Record<string, unknown>;
}

export interface MediaEvidence {
  schemaVersion: 'gbrain.media-evidence.v1';
  kind: MediaExtractionKind;
  sourceRef?: string;
  text: string;
  segments: MediaExtractionSegment[];
  entities: MediaEntity[];
  tags: MediaTag[];
  matchReasons: MediaMatchReason[];
  metadata?: Record<string, unknown>;
}

const MEDIA_KINDS = new Set<MediaExtractionKind>(['image', 'pdf', 'video', 'audio']);
const SEGMENT_KINDS = new Set<MediaSegmentKind>(['asset', 'page', 'frame', 'transcript_segment', 'audio_segment']);
const MATCH_REASON_KINDS = new Set<MediaMatchReason['kind']>([
  'ocr',
  'caption',
  'summary',
  'transcript',
  'entity',
  'tag',
  'visual',
  'metadata',
  'other',
]);

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}

function normalizeMediaKind(value: unknown): MediaExtractionKind | undefined {
  const kind = normalizeString(value);
  if (!kind || !MEDIA_KINDS.has(kind as MediaExtractionKind)) return undefined;
  return kind as MediaExtractionKind;
}

function normalizeSegmentKind(value: unknown): MediaSegmentKind | undefined {
  const kind = normalizeString(value);
  if (!kind || !SEGMENT_KINDS.has(kind as MediaSegmentKind)) return undefined;
  return kind as MediaSegmentKind;
}

function normalizeMatchReasonKind(value: unknown): MediaMatchReason['kind'] | undefined {
  const kind = normalizeString(value);
  if (!kind || !MATCH_REASON_KINDS.has(kind as MediaMatchReason['kind'])) return undefined;
  return kind as MediaMatchReason['kind'];
}

function normalizeLocator(value: unknown): MediaLocator | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const loc = value as Record<string, unknown>;
  const bbox = Array.isArray(loc.bbox) && loc.bbox.length === 4 && loc.bbox.every(n => typeof n === 'number' && Number.isFinite(n))
    ? [loc.bbox[0] as number, loc.bbox[1] as number, loc.bbox[2] as number, loc.bbox[3] as number] as [number, number, number, number]
    : undefined;
  const out: MediaLocator = {
    page: typeof loc.page === 'number' && Number.isFinite(loc.page) ? loc.page : undefined,
    pageLabel: normalizeString(loc.pageLabel),
    frame: typeof loc.frame === 'number' && Number.isFinite(loc.frame) ? loc.frame : undefined,
    timecode: normalizeString(loc.timecode),
    startMs: typeof loc.startMs === 'number' && Number.isFinite(loc.startMs) ? loc.startMs : undefined,
    endMs: typeof loc.endMs === 'number' && Number.isFinite(loc.endMs) ? loc.endMs : undefined,
    bbox,
    timestamp: normalizeString(loc.timestamp),
  };
  return Object.values(out).some(v => v !== undefined) ? out : undefined;
}

function normalizeEntities(values: unknown): MediaEntity[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out: MediaEntity[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const text = normalizeString(row.text);
    if (!text) continue;
    const entity: MediaEntity = { text };
    const type = normalizeString(row.type);
    const confidence = normalizeConfidence(row.confidence);
    if (type) entity.type = type;
    if (confidence !== undefined) entity.confidence = confidence;
    out.push(entity);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeTags(values: unknown): MediaTag[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out: MediaTag[] = [];
  for (const value of values) {
    if (typeof value === 'string') {
      const normalized = normalizeString(value);
      if (normalized) out.push({ value: normalized });
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const tag = normalizeString(row.value);
    if (!tag) continue;
    const normalizedTag: MediaTag = { value: tag };
    const confidence = normalizeConfidence(row.confidence);
    if (confidence !== undefined) normalizedTag.confidence = confidence;
    out.push(normalizedTag);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeMatchReasons(values: unknown): MediaMatchReason[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out: MediaMatchReason[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const kind = normalizeMatchReasonKind(row.kind);
    const detail = normalizeString(row.detail);
    if (!kind || !detail) continue;
    const reason: MediaMatchReason = { kind, detail };
    const confidence = normalizeConfidence(row.confidence);
    if (confidence !== undefined) reason.confidence = confidence;
    out.push(reason);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeSegment(value: unknown, index: number): MediaExtractionSegment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Media extraction segment at index ${index} must be an object`);
  }
  const row = value as Record<string, unknown>;
  const id = normalizeString(row.id) ?? `segment-${index}`;
  const kind = normalizeSegmentKind(row.kind);
  if (!kind) throw new Error(`Media extraction segment ${id} is missing or has invalid kind`);
  return {
    id,
    kind,
    locator: normalizeLocator(row.locator),
    caption: normalizeString(row.caption),
    summary: normalizeString(row.summary),
    ocrText: normalizeString(row.ocrText),
    transcriptText: normalizeString(row.transcriptText),
    entities: normalizeEntities(row.entities),
    tags: normalizeTags(row.tags),
    matchReasons: normalizeMatchReasons(row.matchReasons),
    confidence: normalizeConfidence(row.confidence),
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : undefined,
  };
}

export function normalizeMediaExtraction(input: unknown): MediaExtraction {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Media extraction payload must be an object');
  }
  const row = input as Record<string, unknown>;
  const kind = normalizeMediaKind(row.kind);
  if (!kind) throw new Error('Media extraction payload is missing or has invalid kind');
  const segmentsInput = row.segments;
  if (!Array.isArray(segmentsInput) || segmentsInput.length === 0) {
    throw new Error('Media extraction payload must include at least one segment');
  }
  return {
    schemaVersion: 'gbrain.media-extraction.v1',
    kind,
    sourceRef: normalizeString(row.sourceRef),
    title: normalizeString(row.title),
    summary: normalizeString(row.summary),
    caption: normalizeString(row.caption),
    ocrText: normalizeString(row.ocrText),
    transcriptText: normalizeString(row.transcriptText),
    segments: segmentsInput.map((segment, index) => normalizeSegment(segment, index)),
    entities: normalizeEntities(row.entities),
    tags: normalizeTags(row.tags),
    matchReasons: normalizeMatchReasons(row.matchReasons),
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : undefined,
  };
}

function pushText(parts: string[], value: string | undefined) {
  if (value) parts.push(value);
}

export function mediaExtractionToEvidence(extraction: MediaExtraction): MediaEvidence {
  const parts: string[] = [];
  pushText(parts, extraction.title);
  pushText(parts, extraction.summary);
  pushText(parts, extraction.caption);
  pushText(parts, extraction.ocrText);
  pushText(parts, extraction.transcriptText);

  const entities: MediaEntity[] = [...(extraction.entities ?? [])];
  const tags: MediaTag[] = [...(extraction.tags ?? [])];
  const matchReasons: MediaMatchReason[] = [...(extraction.matchReasons ?? [])];

  for (const segment of extraction.segments) {
    pushText(parts, segment.caption);
    pushText(parts, segment.summary);
    pushText(parts, segment.ocrText);
    pushText(parts, segment.transcriptText);
    if (segment.entities) entities.push(...segment.entities);
    if (segment.tags) tags.push(...segment.tags);
    if (segment.matchReasons) matchReasons.push(...segment.matchReasons);
  }

  return {
    schemaVersion: 'gbrain.media-evidence.v1',
    kind: extraction.kind,
    sourceRef: extraction.sourceRef,
    text: parts.join('\n\n').trim(),
    segments: extraction.segments,
    entities,
    tags,
    matchReasons,
    metadata: extraction.metadata,
  };
}

export function buildMediaEvidenceRawData(input: unknown): MediaEvidence {
  return mediaExtractionToEvidence(normalizeMediaExtraction(input));
}
