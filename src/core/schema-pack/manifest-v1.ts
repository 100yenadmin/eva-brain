// v0.38 Schema Pack Manifest v1
//
// Pack file shape (YAML or JSON; loader.ts handles sniffing). The contract
// here is the SOURCE OF TRUTH for what a `.gbrain-schema` tarball can carry.
//
// Two orthogonal fields per type (E8 refinement):
//   - `primitive` drives DEFAULTS (link verbs, frontmatter rules, enrichment
//     rubric, expert-routing flag inheritance from the primitive's seed).
//   - `aliases` drives QUERY EXPANSION (closure graph). Directed
//     declarations; symmetric per declaration; transitive resolution capped
//     at depth 4. Primitive does NOT drive closure. This prevents
//     adversary-profile (entity primitive) from surfacing in `whoknows expert`
//     just because it shares a primitive with person.
//
// Pack identity (for cache keys, replay records, registry):
//   `<pack-name>@<version>+<manifest-sha8>` (E10).

import { z } from 'zod';

export const SCHEMA_PACK_API_VERSION = 'gbrain-schema-pack-v1' as const;

/**
 * Five composable primitives. Closed enum — packs cannot add primitives,
 * only types that extend one. Compile-time exhaustiveness via
 * `assertNever()` is preserved over THIS enum (where it's actually
 * load-bearing) instead of over the open PageType.
 */
export const PACK_PRIMITIVES = ['entity', 'media', 'temporal', 'annotation', 'concept'] as const;
export type PackPrimitive = typeof PACK_PRIMITIVES[number];

const PackPrimitiveEnum = z.enum(PACK_PRIMITIVES);

const LinkInferenceSchema = z.object({
  regex: z.string().optional(),
  page_type: z.string().optional(),
  target_type: z.string().optional(),
}).strict();

const LinkTypeSchema = z.object({
  name: z.string().min(1),
  inverse: z.string().optional(),
  inference: LinkInferenceSchema.optional(),
}).strict();

const PageTypeSchema = z.object({
  name: z.string().min(1),
  primitive: PackPrimitiveEnum,
  /**
   * Path-prefix patterns inferType consults to map a markdown path to this
   * type. First match wins; order in the pack manifest determines priority.
   */
  path_prefixes: z.array(z.string()).default([]),
  /**
   * E8: explicit alias declarations drive query closure. `researcher`
   * declaring `aliases: [person]` means queries for `researcher` ALSO
   * surface person rows (symmetric per declaration). Empty array = type
   * is isolated in query expansion (adversary-profile, hater-dossier, etc.).
   * Transitive cap = 4 enforced at pack-load.
   */
  aliases: z.array(z.string()).default([]),
  /**
   * Whether the page-type is eligible for facts extraction (gates
   * `src/core/facts/eligibility.ts:49` per T3 codex finding).
   */
  extractable: z.boolean().default(false),
  /**
   * Whether this type is an "expert" for find_experts / whoknows queries
   * (replaces hardcoded ['person','company'] at whoknows.ts:89 + the
   * find_experts SQL hardcodes).
   */
  expert_routing: z.boolean().default(false),
}).strict();

const FrontmatterLinkSchema = z.object({
  page_type: z.string(),
  fields: z.array(z.string()).min(1),
  link_type: z.string(),
}).strict();

const EnrichableSchema = z.object({
  type: z.string(),
  rubric: z.string().optional(),
}).strict();

const FilingRuleSchema = z.object({
  kind: z.string(),
  directory: z.string(),
  examples: z.array(z.string()).default([]),
  description: z.string().optional(),
}).strict();

/**
 * SchemaPackManifest v1 — the parsed + validated pack file shape.
 * `extends` resolution + closure expansion are done by registry.ts, not at
 * parse time.
 */
export const SchemaPackManifestSchema = z.object({
  api_version: z.literal(SCHEMA_PACK_API_VERSION),
  name: z.string().min(1).regex(/^[a-z0-9._-]+$/, 'pack name must be lowercase slug-shape'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver M.m.p'),
  description: z.string().default(''),
  author: z.string().optional(),
  license: z.string().optional(),
  homepage: z.string().url().optional(),
  /** v0.38 — minimum gbrain version required to load this pack. */
  gbrain_min_version: z.string().regex(/^\d+\.\d+\.\d+(?:\.\d+)?$/).default('0.38.0'),
  /** Parent pack (one of: 'gbrain-base', another installed pack name, or null for full override). */
  extends: z.string().nullable().default('gbrain-base'),
  /** v0.38 — selective borrow of types/link_types from another pack. */
  borrow_from: z.array(z.object({
    pack: z.string(),
    types: z.array(z.string()).optional(),
    link_types: z.array(z.string()).optional(),
  }).strict()).default([]),
  page_types: z.array(PageTypeSchema).default([]),
  link_types: z.array(LinkTypeSchema).default([]),
  frontmatter_links: z.array(FrontmatterLinkSchema).default([]),
  takes_kinds: z.array(z.string()).default(['fact', 'take', 'bet', 'hunch']),
  enrichable_types: z.array(EnrichableSchema).default([]),
  filing_rules: z.array(FilingRuleSchema).default([]),
}).strict();

export type SchemaPackManifest = z.infer<typeof SchemaPackManifestSchema>;
export type PackPageType = z.infer<typeof PageTypeSchema>;
export type PackLinkType = z.infer<typeof LinkTypeSchema>;

/**
 * Validation error envelope. Mirrors `StructuredAgentError` shape from
 * `src/core/errors.ts` (v0.19.0) so CLI + MCP surfaces render uniformly.
 */
export class SchemaPackManifestError extends Error {
  readonly code: 'INVALID_API_VERSION' | 'INVALID_SHAPE' | 'INVALID_VERSION';
  readonly path?: string;
  readonly zodIssues?: unknown;

  constructor(
    code: 'INVALID_API_VERSION' | 'INVALID_SHAPE' | 'INVALID_VERSION',
    message: string,
    opts?: { path?: string; zodIssues?: unknown },
  ) {
    super(message);
    this.name = 'SchemaPackManifestError';
    this.code = code;
    this.path = opts?.path;
    this.zodIssues = opts?.zodIssues;
  }
}

/** Parse + validate. Throws SchemaPackManifestError on shape/version issues. */
export function parseSchemaPackManifest(
  raw: unknown,
  opts?: { path?: string },
): SchemaPackManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SchemaPackManifestError(
      'INVALID_SHAPE',
      'manifest must be a JSON/YAML object at the top level',
      { path: opts?.path },
    );
  }
  const apiVersion = (raw as Record<string, unknown>).api_version;
  if (apiVersion !== SCHEMA_PACK_API_VERSION) {
    throw new SchemaPackManifestError(
      'INVALID_API_VERSION',
      `unsupported api_version: ${JSON.stringify(apiVersion)}; expected ${SCHEMA_PACK_API_VERSION}`,
      { path: opts?.path },
    );
  }
  const result = SchemaPackManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new SchemaPackManifestError(
      'INVALID_SHAPE',
      `manifest validation failed: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      { path: opts?.path, zodIssues: result.error.issues },
    );
  }
  return result.data;
}

/** Compute the manifest's content hash (first 8 hex chars of SHA-256). */
export async function computeManifestSha8(manifest: SchemaPackManifest): Promise<string> {
  // Canonical JSON: sorted keys for determinism (E10 + codex F6 hash-determinism).
  const canonical = canonicalJSONStringify(manifest);
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hashBuffer))
    .slice(0, 4)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalJSONStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSONStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSONStringify(obj[k])).join(',') + '}';
}

/**
 * Pack identity — used as cache key, replay record, registry id.
 * Format: `<name>@<version>+<sha8>`. Per codex F7.
 */
export function packIdentity(manifest: SchemaPackManifest, sha8: string): string {
  return `${manifest.name}@${manifest.version}+${sha8}`;
}
