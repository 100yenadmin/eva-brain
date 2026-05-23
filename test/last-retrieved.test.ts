import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { awaitPendingLastRetrievedWrites, bumpLastRetrievedAt } from '../src/core/last-retrieved.ts';

describe('last retrieved write-back', () => {
  test('skips optional write-back on PGLite so local search can exit cleanly', async () => {
    let executeCalled = false;
    const engine = {
      kind: 'pglite',
      async executeRaw() {
        executeCalled = true;
        throw new Error('PGLite write-back should not run');
      },
      async getConfig() {
        return 'true';
      },
    } as unknown as BrainEngine;

    bumpLastRetrievedAt(engine, [1, 2, 3]);
    await awaitPendingLastRetrievedWrites();

    expect(executeCalled).toBe(false);
  });
});
