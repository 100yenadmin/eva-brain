import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runProviders } from '../../src/commands/providers.ts';

const ENV_KEYS = ['GBRAIN_HOME', 'OPENAI_API_KEY', 'GBRAIN_OPENCLAW_AUTH_PROFILES_PATH'];

describe('providers command redaction', () => {
  let tempDir: string;
  let original: Record<string, string | undefined>;
  let logs: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    tempDir = mkdtempSync(join(tmpdir(), 'gbrain-providers-'));
    process.env.GBRAIN_HOME = tempDir;
    logs = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  });

  afterEach(() => {
    console.log = originalLog;
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('list --json reports readiness without secret values', async () => {
    const authPath = join(tempDir, 'auth-profiles.json');
    writeFileSync(authPath, JSON.stringify({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'profile-secret' },
      },
    }));
    process.env.GBRAIN_OPENCLAW_AUTH_PROFILES_PATH = authPath;

    await runProviders('list', ['--json']);
    const output = logs.join('\n');
    expect(output).toContain('"ready": true');
    expect(output).toContain('openclaw:auth-profiles');
    expect(output).not.toContain('profile-secret');
  });

  test('explain --json redacts env secret values', async () => {
    process.env.OPENAI_API_KEY = 'env-secret';

    await runProviders('explain', ['--json']);
    const output = logs.join('\n');
    expect(output).toContain('env:OPENAI_API_KEY');
    expect(output).toContain('"ready": true');
    expect(output).not.toContain('env-secret');
  });
});
