import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { redactAuthResolution, resolveProviderAuth } from '../../src/core/ai/auth.ts';
import { configureGateway, isAvailable, resetGateway } from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import type { AIGatewayConfig } from '../../src/core/ai/types.ts';

const openai = getRecipe('openai');
const ollama = getRecipe('ollama');
if (!openai) throw new Error('openai recipe missing');
if (!ollama) throw new Error('ollama recipe missing');

describe('provider auth resolver', () => {
  let tempDir: string;
  let authPath: string;

  beforeEach(() => {
    resetGateway();
    tempDir = mkdtempSync(join(tmpdir(), 'gbrain-auth-'));
    mkdirSync(join(tempDir, '.openclaw'), { recursive: true });
    authPath = join(tempDir, '.openclaw', 'auth.json');
  });

  afterEach(() => {
    resetGateway();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('env fallback remains highest priority when OpenClaw auth is configured', () => {
    writeOpenClawProfile({ OPENAI_API_KEY: 'oc-secret' });
    const resolution = resolveProviderAuth(openai, config({
      env: { OPENAI_API_KEY: 'env-secret' },
      provider_auth: { openai: { prefer: 'openclaw-codex', openclawAuthPath: authPath } },
    }));
    expect(resolution.source).toBe('env');
    expect(resolution.value).toBe('env-secret');
  });

  test('missing OpenClaw profile reports missing without secret leakage', () => {
    const resolution = resolveProviderAuth(openai, config({
      env: {},
      provider_auth: { openai: { prefer: 'openclaw-codex', profile: 'missing', openclawAuthPath: authPath } },
    }));
    expect(resolution.source).toBe('missing');
    expect(resolution.isConfigured).toBe(false);
    expect(resolution.missingReason).toContain('missing');
    expect(JSON.stringify(redactAuthResolution(resolution))).not.toContain('secret');
  });

  test('selected OpenClaw profile provides credential source class', () => {
    writeOpenClawProfile({ OPENAI_API_KEY: 'oc-secret' });
    const resolution = resolveProviderAuth(openai, config({
      env: {},
      provider_auth: { openai: { prefer: 'openclaw-codex', openclawAuthPath: authPath } },
    }));
    expect(resolution.source).toBe('openclaw-codex');
    expect(resolution.credentialKey).toBe('OPENAI_API_KEY');
    expect(resolution.value).toBe('oc-secret');
  });

  test('redaction omits token values', () => {
    writeOpenClawProfile({ OPENAI_API_KEY: 'oc-secret' });
    const resolution = resolveProviderAuth(openai, config({
      env: {},
      provider_auth: { openai: { prefer: 'openclaw-codex', openclawAuthPath: authPath } },
    }));
    const redacted = redactAuthResolution(resolution);
    expect(JSON.stringify(redacted)).not.toContain('oc-secret');
    expect(redacted).toMatchObject({ source: 'openclaw-codex', credentialKey: 'OPENAI_API_KEY' });
  });

  test('unauthenticated local provider remains configured', () => {
    const resolution = resolveProviderAuth(ollama, config({ env: {} }));
    expect(resolution.source).toBe('unauthenticated');
    expect(resolution.isConfigured).toBe(true);
  });

  test('gateway embedding availability respects selected OpenClaw profile', () => {
    writeOpenClawProfile({ OPENAI_API_KEY: 'oc-secret' });
    configureGateway(config({
      embedding_model: 'openai:text-embedding-3-large',
      provider_auth: { openai: { prefer: 'openclaw-codex', openclawAuthPath: authPath } },
      env: {},
    }));
    expect(isAvailable('embedding')).toBe(true);
  });

  test('gateway chat availability respects selected OpenClaw profile', () => {
    writeOpenClawProfile({ OPENAI_API_KEY: 'oc-secret' });
    configureGateway(config({
      chat_model: 'openai:gpt-5.2',
      provider_auth: { openai: { prefer: 'openclaw-codex', openclawAuthPath: authPath } },
      env: {},
    }));
    expect(isAvailable('chat')).toBe(true);
  });

  test('gateway availability is false when selected profile is missing', () => {
    configureGateway(config({
      embedding_model: 'openai:text-embedding-3-large',
      provider_auth: { openai: { prefer: 'openclaw-codex', openclawAuthPath: authPath } },
      env: {},
    }));
    expect(isAvailable('embedding')).toBe(false);
  });

  function writeOpenClawProfile(record: Record<string, string>): void {
    writeFileSync(authPath, JSON.stringify({ profiles: { 'openclaw-codex': record } }));
  }
});

function config(overrides: Partial<AIGatewayConfig>): AIGatewayConfig {
  return {
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    expansion_model: 'anthropic:claude-haiku-4-5-20251001',
    chat_model: 'anthropic:claude-sonnet-4-6-20250929',
    env: {},
    ...overrides,
  };
}
