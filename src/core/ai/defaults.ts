/**
 * Leaf module holding the default embedding model + dimensions.
 *
 * Extracted so schema helpers (pglite-schema.ts, postgres-engine.ts) +
 * registry helpers (search/embedding-column.ts) can import the constants
 * without pulling the full AI gateway (which loads every provider SDK).
 *
 * gateway.ts re-exports these so existing import sites keep working.
 *
 * Single source of truth for "what does a fresh brain look like when the
 * user passes zero flags?" Touching these defaults touches every fresh
 * install AND every doctor consistency check.
 */

// Eva downstream default: Voyage 4 Large at 2048d.
//
// Upstream keeps ZeroEntropy as the general GBrain default after its eval
// work. Eva keeps that provider available, but fresh Eva/OpenClaw installs
// size the primary text column for Voyage because that is the supported fleet
// posture and matches INSTALL_FOR_AGENTS.md.
export const DEFAULT_EMBEDDING_MODEL = 'voyage:voyage-4-large';
export const DEFAULT_EMBEDDING_DIMENSIONS = 2048;
