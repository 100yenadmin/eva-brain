# Eva downstream carry patches

Eva Brain uses upstream GBrain as its core. Core changes in this file are temporary and must be removed when upstream ships equivalent behavior.

## Extraction freshness watermark

- Files: `src/commands/extract.ts`, `test/extract-stale.test.ts`
- Reason: a completed stale extraction sweep must advance old pages to at least `LINK_EXTRACTOR_VERSION_TS`; otherwise doctor repeatedly reports already-processed pages as stale.
- Removal condition: upstream merges equivalent watermark handling and regression coverage.
- Upstream tracking: <https://github.com/garrytan/gbrain/pull/3018>

## Bounded timeline citation parsing

- Files: `src/commands/extract.ts`, `test/extract.test.ts`
- Reason: imported document lines must not trigger unbounded regex backtracking while parsing inline `[Source: ..., YYYY-MM-DD]` citations.
- Removal condition: upstream ships an equivalent bounded parser and regression coverage.

## Book-mirror frontmatter escaping

- Files: `src/commands/book-mirror.ts`, `test/book-mirror.test.ts`
- Reason: user-supplied titles, authors, and context must remain valid YAML when they contain backslashes, quotes, or line breaks.
- Removal condition: upstream escapes all double-quoted frontmatter values equivalently and carries regression coverage.

## v123 overflow-safe FTS backfill

- Files: `src/core/migrate.ts`, `test/fts-language-migration.serial.test.ts`
- Reason: non-English brains must not backfill `compiled_truth` through the old trigger and abort before v124 installs the overflow-safe shape.
- Removal condition: upstream v123 uses the post-v124 page trigger shape or otherwise guarantees v124 runs before any unsafe backfill.

## Read and sync bounds

- Files: `src/core/operations.ts`, `src/commands/sync.ts`, focused tests.
- Reason: remote timeline reads need a bounded result limit; subpath full sync must not clear failure-ledger rows it did not retry; and incremental sync containment must work with native Windows paths.
- Removal condition: upstream ships equivalent operation-boundary clamping, scope-aware failure clearing, and platform-aware path containment.

## Source-root facts fence writes

- Files: `src/core/facts/fence-write.ts`, `test/fence-write.test.ts`
- Reason: `sources.local_path` is already the source's own working-tree root. Facts must update `<local_path>/<slug>.md`, matching `put_page`, rather than creating a second hidden `.sources/<id>` tree that later syncs do not read.
- Removal condition: upstream aligns fact fence writes with its per-source `local_path` write-through behavior and carries regression coverage.

## Honest schema-pack stats failures

- Files: `src/core/schema-pack/stats.ts`, `test/schema-pack-stats.test.ts`
- Reason: only a truly missing `pages` table means an empty brain. Other database failures must surface instead of being reported as zero pages.
- Removal condition: upstream distinguishes missing-table errors from unexpected query/database failures.

## Install-time migration policy

- File: `package.json`
- Reason: dependency installation is advisory-only in the Eva distribution. Customer migrations are explicit, backed up, and operator-controlled.
- Removal condition: none while Eva ships to managed customer runtimes. This is a distribution policy, not an upstream bug.
