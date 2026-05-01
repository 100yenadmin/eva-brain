import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { homedir } from 'os';
import type { GBrainConfig } from '../config.ts';

export type OpenAIAuthSource =
  | 'env:OPENAI_API_KEY'
  | 'config:openai_api_key'
  | 'openclaw:auth-profiles'
  | 'openclaw:legacy-auth-json'
  | 'missing';

export interface OpenAIAuthResolution {
  source: OpenAIAuthSource;
  isConfigured: boolean;
  credentialKey?: string;
  value?: string;
  profileId?: string;
  provider?: string;
  missingReason?: string;
}

interface ResolveOpenAIAuthOptions {
  env?: Record<string, string | undefined>;
  config?: Pick<GBrainConfig, 'openai_api_key'> | null;
}

const OPENCLAW_PROFILE_PROVIDERS = new Set(['openai', 'openai-codex']);
const LEGACY_PROFILE_IDS = ['openai', 'openai:default', 'openai-codex', 'openai-codex:default'];

/**
 * Resolve the credential gbrain should use for OpenAI-compatible calls.
 *
 * Precedence stays backward-compatible: explicit env wins, then gbrain config,
 * then an OpenClaw-managed auth profile/bridge. This function never logs or
 * returns secrets through redaction helpers.
 */
export function resolveOpenAIAuth(options: ResolveOpenAIAuthOptions = {}): OpenAIAuthResolution {
  const env = options.env ?? process.env;
  const config = options.config ?? null;

  const envKey = env.OPENAI_API_KEY?.trim();
  if (envKey) {
    return {
      source: 'env:OPENAI_API_KEY',
      credentialKey: 'OPENAI_API_KEY',
      value: envKey,
      isConfigured: true,
    };
  }

  const configKey = config?.openai_api_key?.trim();
  if (configKey) {
    return {
      source: 'config:openai_api_key',
      credentialKey: 'openai_api_key',
      value: configKey,
      isConfigured: true,
    };
  }

  const bridged = resolveOpenClawProfileAuth(env);
  if (bridged) return bridged;

  return {
    source: 'missing',
    credentialKey: 'OPENAI_API_KEY',
    isConfigured: false,
    missingReason: 'Missing OPENAI_API_KEY, gbrain config openai_api_key, or readable OpenClaw OpenAI/Codex auth profile.',
  };
}

export function getOpenAIApiKey(options: ResolveOpenAIAuthOptions = {}): string | undefined {
  return resolveOpenAIAuth(options).value;
}

export function hasOpenAIAuth(options: ResolveOpenAIAuthOptions = {}): boolean {
  return resolveOpenAIAuth(options).isConfigured;
}

export function redactAuthResolution(resolution: OpenAIAuthResolution): Omit<OpenAIAuthResolution, 'value'> {
  const { value: _value, ...redacted } = resolution;
  return redacted;
}

function resolveOpenClawProfileAuth(env: Record<string, string | undefined>): OpenAIAuthResolution | null {
  for (const path of openClawAuthCandidatePaths(env)) {
    const raw = readJson(path);
    if (!raw) continue;

    const fromStore = resolveFromAuthProfiles(raw, env);
    if (fromStore) return fromStore;

    const fromLegacy = resolveFromLegacyAuthJson(raw);
    if (fromLegacy) return fromLegacy;
  }
  return null;
}

function openClawAuthCandidatePaths(env: Record<string, string | undefined>): string[] {
  const explicit = [
    env.GBRAIN_OPENCLAW_AUTH_PROFILES_PATH,
    env.OPENCLAW_AUTH_PROFILES_PATH,
    env.GBRAIN_OPENCLAW_AUTH_PATH,
    env.OPENCLAW_AUTH_PATH,
  ];
  const explicitPaths = normalizeCandidatePaths(explicit);
  if (explicitPaths.length > 0) return explicitPaths;

  const candidates = [
    env.OPENCLAW_AGENT_DIR ? join(env.OPENCLAW_AGENT_DIR, 'auth-profiles.json') : undefined,
    env.PI_CODING_AGENT_DIR ? join(env.PI_CODING_AGENT_DIR, 'auth-profiles.json') : undefined,
    join(homedir(), '.openclaw', 'state', 'agents', 'main', 'agent', 'auth-profiles.json'),
    join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json'),
    join(homedir(), '.openclaw', 'auth.json'),
  ];
  return normalizeCandidatePaths(candidates);
}

function normalizeCandidatePaths(candidates: Array<string | undefined>): string[] {
  return [...new Set(candidates.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map(expandUserPath))];
}

function expandUserPath(pathname: string): string {
  const trimmed = pathname.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : join(homedir(), trimmed);
}

function readJson(pathname: string): unknown | null {
  try {
    if (!existsSync(pathname)) return null;
    return JSON.parse(readFileSync(pathname, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function resolveFromAuthProfiles(raw: unknown, env: Record<string, string | undefined>): OpenAIAuthResolution | null {
  const root = asRecord(raw);
  const profiles = asRecord(root?.profiles);
  if (!profiles) return null;

  const preferredIds = [...LEGACY_PROFILE_IDS, ...Object.keys(profiles)];
  for (const profileId of [...new Set(preferredIds)]) {
    const profile = asRecord(profiles[profileId]);
    if (!profile) continue;
    const provider = typeof profile.provider === 'string' ? profile.provider : undefined;
    if (!provider || !OPENCLAW_PROFILE_PROVIDERS.has(provider)) continue;

    const resolved = resolveProfileCredential(profile, env, provider);
    if (!resolved) continue;

    return {
      source: 'openclaw:auth-profiles',
      credentialKey: resolved.credentialKey,
      value: resolved.value,
      isConfigured: true,
      profileId,
      provider,
    };
  }
  return null;
}

function resolveProfileCredential(profile: Record<string, unknown>, env: Record<string, string | undefined>, provider: string): { credentialKey: string; value: string } | null {
  const keyRef = asRecord(profile.keyRef);
  if (keyRef?.source === 'env' && typeof keyRef.id === 'string') {
    const value = env[keyRef.id]?.trim();
    if (value && isOpenAICompatibleCredential(provider, keyRef.id, 'keyRef')) return { credentialKey: keyRef.id, value };
  }

  const tokenRef = asRecord(profile.tokenRef);
  if (tokenRef?.source === 'env' && typeof tokenRef.id === 'string') {
    const value = env[tokenRef.id]?.trim();
    if (value && isOpenAICompatibleCredential(provider, tokenRef.id, 'tokenRef')) return { credentialKey: tokenRef.id, value };
  }

  for (const field of ['key', 'token', 'access']) {
    const value = profile[field];
    if (typeof value === 'string' && value.trim() && isOpenAICompatibleCredential(provider, field, field)) {
      return { credentialKey: field, value: value.trim() };
    }
  }

  return null;
}

function isOpenAICompatibleCredential(provider: string, credentialKey: string, field: string): boolean {
  if (provider === 'openai') return true;
  // Codex OAuth access tokens are not the same thing as OpenAI embedding API
  // keys. Accept only explicit OpenAI-compatible bridge material from a Codex
  // profile; otherwise leave the provider missing instead of failing at call time.
  if (provider === 'openai-codex') {
    return field === 'key' || credentialKey === 'OPENAI_API_KEY';
  }
  return false;
}

function resolveFromLegacyAuthJson(raw: unknown): OpenAIAuthResolution | null {
  const root = asRecord(raw);
  if (!root) return null;

  for (const id of LEGACY_PROFILE_IDS) {
    const direct = asRecord(root[id]) ?? asRecord(asRecord(root.profiles)?.[id]);
    if (!direct) continue;
    for (const key of ['OPENAI_API_KEY']) {
      const value = direct[key];
      if (typeof value === 'string' && value.trim()) {
        return {
          source: 'openclaw:legacy-auth-json',
          credentialKey: key,
          value: value.trim(),
          isConfigured: true,
          profileId: id,
        };
      }
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}
