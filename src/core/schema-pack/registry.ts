// v0.38 schema pack registry — load, cache, resolve active pack.
//
// Pack resolution chain (7 tiers per D13, tier-1 trust-gated):
//   1. Per-call `schema_pack` opt — CLI only (`ctx.remote === false`).
//      Rejected for `ctx.remote === true` (D13 trust boundary).
//   2. `GBRAIN_SCHEMA_PACK` env var
//   3. Per-source DB config key `schema_pack.source.<id>` (dots, not
//      colons — codex F16, matches `models.tier.*` convention)
//   4. Brain-wide DB config key `schema_pack`
//   5. `gbrain.yml schema:` section
//   6. `~/.gbrain/config.json schema_pack` field
//   7. Default `gbrain-base`
//
// Extends chain semantics (E4):
//   - Depth tracked via BFS during resolve.
//   - Soft warn to stderr at depth > 4.
//   - Hard reject at depth > 8 with paste-ready "shorten your extends
//     chain" hint.
//
// Cache: resolved packs are cached in-memory by pack-identity
// (`<name>@<version>+<sha8>`). Mtime check via `loadPackFromFile` on
// disk-backed packs invalidates the cache when a user edits the
// manifest.

import type { SchemaPackManifest } from './manifest-v1.ts';
import { computeManifestSha8, packIdentity } from './manifest-v1.ts';
import { computeAliasClosureHash, buildAliasGraph, type AliasGraph } from './closure.ts';

export const EXTENDS_DEPTH_WARN = 4 as const;
export const EXTENDS_DEPTH_HARD_CAP = 8 as const;

export class ExtendsChainTooDeepError extends Error {
  readonly depth: number;
  readonly chain: string[];
  constructor(depth: number, chain: string[]) {
    super(`pack extends chain depth ${depth} exceeds hard cap ${EXTENDS_DEPTH_HARD_CAP}: ${chain.join(' → ')}`);
    this.name = 'ExtendsChainTooDeepError';
    this.depth = depth;
    this.chain = chain;
  }
}

export class UnknownPackError extends Error {
  readonly name_: string;
  constructor(name_: string) {
    super(`unknown schema pack: ${name_}`);
    this.name = 'UnknownPackError';
    this.name_ = name_;
  }
}

/**
 * The fully resolved pack — manifest + computed graph + identity hash.
 * Returned by `loadActivePack`; cached by registry until the source
 * manifest mtime changes.
 */
export interface ResolvedPack {
  manifest: SchemaPackManifest;
  identity: string;        // `<name>@<version>+<sha8>`
  manifest_sha8: string;
  alias_closure_hash: string;
  alias_graph: AliasGraph;
}

/**
 * 7-tier resolution chain. Returns the pack NAME to load (resolved
 * packs are fetched separately via `loadPackByName`). Tier 1 (per-call)
 * is gated on `remote === false`; remote callers passing the opt get
 * `permission_denied` from operations.ts before reaching here.
 */
export interface ResolutionInput {
  /** Tier 1: per-call opt. ONLY honored when `remote === false`. */
  perCall?: string;
  /** Tier 1 trust gate. `true` = MCP/OAuth caller; rejects per-call opt. */
  remote: boolean;
  /** Tier 3: per-source DB config map (source_id → pack name). */
  perSourceDb?: ReadonlyMap<string, string>;
  /** Source ID the query targets (tier 3 lookup). */
  sourceId?: string;
  /** Tier 2: env var (`GBRAIN_SCHEMA_PACK`). */
  envVar?: string;
  /** Tier 4: brain-wide DB config. */
  dbConfig?: string;
  /** Tier 5: gbrain.yml schema.pack field. */
  gbrainYml?: string;
  /** Tier 6: ~/.gbrain/config.json schema_pack field. */
  homeConfig?: string;
}

/** Resolved tier + pack name. `source` documents which tier won. */
export interface ResolutionResult {
  pack_name: string;
  source: 'per-call' | 'env' | 'per-source-db' | 'db-config' | 'gbrain-yml' | 'home-config' | 'default';
}

export function resolveActivePackName(input: ResolutionInput): ResolutionResult {
  // Tier 1: per-call opt (CLI only).
  if (input.perCall && input.remote === false) {
    return { pack_name: input.perCall, source: 'per-call' };
  }
  // Tier 2: env var.
  if (input.envVar) return { pack_name: input.envVar, source: 'env' };
  // Tier 3: per-source DB config.
  if (input.sourceId && input.perSourceDb?.has(input.sourceId)) {
    return { pack_name: input.perSourceDb.get(input.sourceId)!, source: 'per-source-db' };
  }
  // Tier 4: brain-wide DB.
  if (input.dbConfig) return { pack_name: input.dbConfig, source: 'db-config' };
  // Tier 5: gbrain.yml schema:
  if (input.gbrainYml) return { pack_name: input.gbrainYml, source: 'gbrain-yml' };
  // Tier 6: ~/.gbrain/config.json
  if (input.homeConfig) return { pack_name: input.homeConfig, source: 'home-config' };
  // Tier 7: default
  return { pack_name: 'gbrain-base', source: 'default' };
}

/**
 * In-memory cache keyed by pack-identity. Resolved packs are immutable
 * once loaded; the cache is invalidated by mtime check in the
 * disk-loader callers.
 */
const _packCache = new Map<string, ResolvedPack>();

/** Test seam — clears the in-process resolver cache. */
export function _resetPackCacheForTests(): void {
  _packCache.clear();
}

/**
 * Resolve + cache a manifest. Loads parent packs via the `loadByName`
 * dependency, tracks extends-chain depth, applies the E4 cap.
 *
 * Pass `loadByName` as a dependency so the registry doesn't have to
 * own filesystem layout (tests inject a mock; production wires the
 * disk loader).
 */
export async function resolvePack(
  manifest: SchemaPackManifest,
  loadByName: (name: string) => Promise<SchemaPackManifest>,
  opts: { onDepthWarn?: (depth: number, chain: string[]) => void } = {},
): Promise<ResolvedPack> {
  const sha8 = await computeManifestSha8(manifest);
  const id = packIdentity(manifest, sha8);
  const cached = _packCache.get(id);
  if (cached) return cached;

  // Walk extends chain to enforce depth cap.
  const chain: string[] = [manifest.name];
  let cursor: SchemaPackManifest | null = manifest;
  while (cursor?.extends) {
    const parentName = cursor.extends;
    if (chain.includes(parentName)) {
      // Cycle in extends graph — should be impossible for legit packs;
      // safety net.
      throw new ExtendsChainTooDeepError(chain.length, [...chain, parentName]);
    }
    chain.push(parentName);
    if (chain.length > EXTENDS_DEPTH_HARD_CAP) {
      throw new ExtendsChainTooDeepError(chain.length, chain);
    }
    if (chain.length > EXTENDS_DEPTH_WARN) {
      opts.onDepthWarn?.(chain.length, chain);
    }
    cursor = await loadByName(parentName);
  }

  // For v0.38 skeleton: the closure is computed on the manifest itself.
  // T7 Phase B will add full extends-merging (child-wins) here. For now,
  // we treat manifest.page_types as the effective set (gbrain-base
  // codegen places everything in the seed manifest directly).
  const alias_graph = buildAliasGraph(manifest);
  const alias_closure_hash = await computeAliasClosureHash(manifest);

  const resolved: ResolvedPack = {
    manifest,
    identity: id,
    manifest_sha8: sha8,
    alias_closure_hash,
    alias_graph,
  };
  _packCache.set(id, resolved);
  return resolved;
}
