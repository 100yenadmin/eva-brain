import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { hasOpenAIAuth, redactAuthResolution, resolveOpenAIAuth } from '../../src/core/ai/auth.ts';

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'GBRAIN_OPENCLAW_AUTH_PROFILES_PATH',
  'OPENCLAW_AUTH_PROFILES_PATH',
  'GBRAIN_OPENCLAW_AUTH_PATH',
  'OPENCLAW_AUTH_PATH',
  'OPENCLAW_AGENT_DIR',
  'PI_CODING_AGENT_DIR',
  'PROFILE_KEY_ENV',
];

describe('OpenAI auth resolver', () => {
  let tempDir: string;
  let original: Record<string, string | undefined>;

  beforeEach(() => {
    original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    tempDir = mkdtempSync(join(tmpdir(), 'gbrain-openclaw-auth-'));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('env OPENAI_API_KEY is highest priority', () => {
    process.env.OPENAI_API_KEY = 'env-secret';
    const resolution = resolveOpenAIAuth({ config: { openai_api_key: 'config-secret' } });
    expect(resolution.source).toBe('env:OPENAI_API_KEY');
    expect(resolution.value).toBe('env-secret');
  });

  test('gbrain config key is used when env is absent', () => {
    const resolution = resolveOpenAIAuth({ config: { openai_api_key: 'config-secret' } });
    expect(resolution.source).toBe('config:openai_api_key');
    expect(resolution.value).toBe('config-secret');
    expect(hasOpenAIAuth({ config: { openai_api_key: 'config-secret' } })).toBe(true);
  });

  test('OpenClaw auth-profiles api_key profile bridges OpenAI credentials', () => {
    const path = join(tempDir, 'auth-profiles.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      profiles: {
        'openai:default': { type: 'api_key', provider: 'openai', key: 'profile-secret' },
      },
    }));
    process.env.GBRAIN_OPENCLAW_AUTH_PROFILES_PATH = path;

    const resolution = resolveOpenAIAuth({ config: null });
    expect(resolution.source).toBe('openclaw:auth-profiles');
    expect(resolution.profileId).toBe('openai:default');
    expect(resolution.value).toBe('profile-secret');
  });

  test('OpenClaw env secret-ref profile resolves through host-provided env bridge', () => {
    const path = join(tempDir, 'auth-profiles.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      profiles: {
        'openai:default': {
          type: 'api_key',
          provider: 'openai',
          keyRef: { source: 'env', id: 'PROFILE_KEY_ENV' },
        },
      },
    }));
    process.env.GBRAIN_OPENCLAW_AUTH_PROFILES_PATH = path;
    process.env.PROFILE_KEY_ENV = 'bridged-secret';

    const resolution = resolveOpenAIAuth({ config: null });
    expect(resolution.source).toBe('openclaw:auth-profiles');
    expect(resolution.credentialKey).toBe('PROFILE_KEY_ENV');
    expect(resolution.value).toBe('bridged-secret');
  });

  test('OpenClaw Codex OAuth token profile is not treated as an OpenAI embedding key', () => {
    const path = join(tempDir, 'auth-profiles.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      profiles: {
        'openai-codex:default': { type: 'token', provider: 'openai-codex', token: 'codex-token' },
      },
    }));
    process.env.GBRAIN_OPENCLAW_AUTH_PROFILES_PATH = path;

    const resolution = resolveOpenAIAuth({ config: null });
    expect(resolution.source).toBe('missing');
    expect(JSON.stringify(redactAuthResolution(resolution))).not.toContain('codex-token');
  });

  test('OpenClaw Codex profile can carry an explicit OpenAI-compatible bridge key', () => {
    const path = join(tempDir, 'auth-profiles.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      profiles: {
        'openai-codex:default': { type: 'api_key', provider: 'openai-codex', key: 'bridge-key' },
      },
    }));
    process.env.GBRAIN_OPENCLAW_AUTH_PROFILES_PATH = path;

    const resolution = resolveOpenAIAuth({ config: null });
    expect(resolution.source).toBe('openclaw:auth-profiles');
    expect(resolution.provider).toBe('openai-codex');
    expect(resolution.value).toBe('bridge-key');
  });

  test('legacy auth.json profile shape is supported without leaking malformed content', () => {
    const path = join(tempDir, 'auth.json');
    writeFileSync(path, JSON.stringify({ profiles: { 'openai-codex': { OPENAI_API_KEY: 'legacy-secret' } } }));
    process.env.GBRAIN_OPENCLAW_AUTH_PATH = path;

    const resolution = resolveOpenAIAuth({ config: null });
    expect(resolution.source).toBe('openclaw:legacy-auth-json');
    expect(resolution.value).toBe('legacy-secret');

    const redacted = redactAuthResolution(resolution);
    expect(JSON.stringify(redacted)).not.toContain('legacy-secret');
  });

  test('missing or malformed profiles produce redacted missing result', () => {
    const path = join(tempDir, 'auth-profiles.json');
    writeFileSync(path, '{not json');
    process.env.GBRAIN_OPENCLAW_AUTH_PROFILES_PATH = path;

    const resolution = resolveOpenAIAuth({ config: null });
    expect(resolution.source).toBe('missing');
    expect(resolution.isConfigured).toBe(false);
    expect(JSON.stringify(redactAuthResolution(resolution))).not.toContain('{not json');
  });
});
