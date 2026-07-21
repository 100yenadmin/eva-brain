import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = new URL('..', import.meta.url).pathname;
const pluginSource = readFileSync(join(repoRoot, 'plugins/openclaw-gbrain/index.js'), 'utf-8');
const pluginReadme = readFileSync(join(repoRoot, 'plugins/openclaw-gbrain/README.md'), 'utf-8');
const manifest = JSON.parse(
  readFileSync(join(repoRoot, 'plugins/openclaw-gbrain/openclaw.plugin.json'), 'utf-8'),
);

describe('OpenClaw GBrain plugin boundary', () => {
  test('owns the OAuth-backed extraction route instead of putting it in GBrain core', () => {
    expect(pluginSource).toContain('GBRAIN_ROUTE_PATH = "/plugins/gbrain/extract"');
    expect(pluginSource).toContain('api.registerHttpRoute');
    expect(pluginSource).toContain('auth: "gateway"');
    expect(pluginSource).toContain('"--gateway"');
    expect(pluginSource).not.toContain('"--local"');
    expect(pluginSource).toContain('protocol: "gbrain.media-extraction.v1"');
    expect(pluginSource).toContain('provider: "openai"');
    expect(pluginSource).toContain('DEFAULT_EXTRACTION_MODEL = "openai/gpt-5.4-mini"');
    expect(pluginSource).toContain('namespaced.startsWith("openai-codex/")');
  });

  test('keeps extraction pressure controls in the plugin config contract', () => {
    const props = manifest.configSchema.properties;
    expect(props.maxConcurrentExtractions).toBeTruthy();
    expect(props.extractionQueueLimit).toBeTruthy();
    expect(props.extractionQueueTimeoutMs).toBeTruthy();
    expect(props.minExtractionIntervalMs).toBeTruthy();
    expect(props.maxExtractionFileBytes).toBeTruthy();

    expect(pluginSource).toContain('DEFAULT_MAX_CONCURRENT_EXTRACTIONS = 1');
    expect(pluginSource).toContain('DEFAULT_EXTRACTION_QUEUE_LIMIT = 8');
    expect(pluginSource).toContain('DEFAULT_MAX_EXTRACTION_FILE_BYTES = 8_000_000');
    expect(pluginReadme).toContain('"maxExtractionFileBytes": 8000000');
  });

  test('exposes source-aware and operator-safe read tools for agents', () => {
    expect(manifest.contracts.tools).toContain('gbrain_status');
    expect(manifest.contracts.tools).toContain('gbrain_search');
    expect(manifest.contracts.tools).toContain('gbrain_query');
    expect(manifest.contracts.tools).toContain('gbrain_doctor');
    expect(manifest.contracts.tools).toContain('gbrain_extract_status');
    expect(manifest.contracts.tools).toContain('gbrain_extract_explain');
    expect(manifest.contracts.tools).toContain('gbrain_schema_active');

    expect(pluginSource).toContain('"status", "--json"');
    expect(pluginSource).toContain('"doctor", "--scope=brain", "--json"');
    expect(pluginSource).toContain('"sources", "list", "--json"');
    expect(pluginSource).toContain('appendSourceArg(["search", query, "--limit", String(limit)], source.sourceId)');
    expect(pluginSource).toContain('appendSourceArg(["query", question], source.sourceId)');
    expect(pluginSource).toContain('"extract", "status", "--json"');
    expect(pluginSource).toContain('"extract", "--explain", kind, "--json"');
    expect(pluginSource).toContain('"schema", "active"');
  });

  test('rejects oversized or malformed file payloads before temp files or model calls', () => {
    expect(pluginSource).toContain('decodedBase64ByteLength');
    expect(pluginSource).toContain('normalizeBase64Payload');
    expect(pluginSource).toContain('file_too_large');
    expect(pluginSource).toContain('invalid_file_base64');
    expect(pluginSource.indexOf('readImageInput(request, config)')).toBeGreaterThan(-1);
    expect(pluginSource.indexOf('await writeFile(imagePath')).toBeGreaterThan(
      pluginSource.indexOf('readImageInput(request, config)'),
    );
  });

  test('does not construct model API-key payload fields in the extraction route', () => {
    expect(pluginSource).not.toContain('apiKey');
    expect(pluginSource).not.toContain('OPENAI_API_KEY');
    expect(pluginSource).not.toContain('refreshToken');
    expect(pluginSource).not.toContain('accessToken');
  });

  test('spawned helper commands keep runtime env precedence over gbrain.env', () => {
    expect(pluginSource).toContain('...fileEnv,');
    expect(pluginSource).toContain('...process.env,');
    expect(pluginSource.indexOf('...fileEnv,')).toBeLessThan(pluginSource.indexOf('...process.env,'));
    expect(pluginSource).toContain('process.env.BUN_INSTALL ?? fileEnv.BUN_INSTALL');
    expect(pluginSource).toContain('process.env.PATH ?? fileEnv.PATH');
  });

  test('escalates timed-out helper processes that ignore SIGTERM', () => {
    expect(pluginSource).toContain('child.kill("SIGTERM")');
    expect(pluginSource).toContain('child.exitCode === null && child.signalCode === null');
    expect(pluginSource).toContain('child.kill("SIGKILL")');
    expect(pluginSource).not.toContain('if (!child.killed) child.kill("SIGKILL")');
  });
});
