import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('release distribution contract', () => {
  test('generic dist output stays ignored while admin SPA assets remain trackable', () => {
    const ignored = Bun.spawnSync(
      ['git', 'check-ignore', '--no-index', '--quiet', 'dist/openclaw-plugin.js'],
      { cwd: repoRoot },
    );
    const adminAsset = Bun.spawnSync(
      ['git', 'check-ignore', '--no-index', '--quiet', 'admin/dist/assets/index-future-hash.js'],
      { cwd: repoRoot },
    );

    expect(ignored.exitCode).toBe(0);
    expect(adminAsset.exitCode).toBe(1);
  });

  test('OSV pull-request filter includes root and admin dependency manifests', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/osv-scanner.yml'), 'utf8');

    expect(workflow).toContain("- 'bun.lock'");
    expect(workflow).toContain("- 'package.json'");
    expect(workflow).toContain("- 'admin/bun.lock'");
    expect(workflow).toContain("- 'admin/package.json'");
  });
});
