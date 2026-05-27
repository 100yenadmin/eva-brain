import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();

function readJson(path: string) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

describe('Eva Brain thin distribution contract', () => {
  test('root package stays upstream-compatible but Eva-owned and install-safe', () => {
    const pkg = readJson('package.json');

    expect(pkg.name).toBe('gbrain');
    expect(pkg.repository?.url).toContain('electricsheephq/eva-brain');
    expect(pkg.scripts?.postinstall.startsWith('echo ')).toBe(true);
    expect(pkg.scripts?.postinstall).toContain('INSTALL_FOR_AGENTS.md');
    expect(pkg.scripts?.postinstall).not.toContain('apply-migrations');
    expect(pkg.scripts?.postinstall).not.toContain('openclaw gateway restart');
  });

  test('repo-owned version surfaces track the package version', () => {
    const pkg = readJson('package.json');
    const rootManifest = readJson('openclaw.plugin.json');
    const skillManifest = readJson('skills/manifest.json');
    const codexPkg = readJson('plugins/gbrain-codex/package.json');
    const codexPlugin = readJson('plugins/gbrain-codex/.codex-plugin/plugin.json');
    const openclawPkg = readJson('plugins/openclaw-gbrain/package.json');
    const versionSource = readFileSync(join(root, 'src/version.ts'), 'utf8');

    expect(rootManifest.version).toBe(pkg.version);
    expect(skillManifest.version).toBe(pkg.version);
    expect(codexPkg.version).toBe(pkg.version);
    expect(codexPlugin.version).toBe(pkg.version);
    expect(openclawPkg.version).toBe(pkg.version);
    expect(versionSource).toContain('pkg.version');
  });

  test('root bundle plugin launches the installed gbrain runtime', () => {
    const manifest = readJson('openclaw.plugin.json');
    const server = manifest.mcpServers?.gbrain;

    expect(server?.command).toBe('gbrain');
    expect(server?.args).toEqual(['serve']);
    expect(manifest.configSchema?.database_url?.required).toBe(false);
    expect(manifest.configSchema).not.toHaveProperty('voyage_api_key');
    expect(manifest.contracts?.contextEngines).toContain('gbrain-context');
  });

  test('agent install guide documents the Eva profile and source-aware KB checks', () => {
    const guide = readFileSync(join(root, 'INSTALL_FOR_AGENTS.md'), 'utf8');

    expect(guide).toContain('https://github.com/electricsheephq/eva-brain.git');
    expect(guide).toContain('voyage:voyage-4-large');
    expect(guide).toContain('--embedding-dimensions 2048');
    expect(guide).toContain('/plugins/gbrain/extract');
    expect(guide).toContain('openclaw plugins install');
    expect(guide).toContain('OPENCLAW_SUPPORT_KB_REPO');
    expect(guide).toContain('GBRAIN_ROOT="${GBRAIN_HOME:-$HOME}"');
    expect(guide).toContain('GBRAIN_ROOT/.gbrain/sources/openclaw-support-kb');
    expect(guide).toContain('https://github.com/electricsheephq/openclaw-support-kb.git');
    expect(guide).toContain('node scripts/update-client.mjs');
    expect(guide).toContain('node scripts/status.mjs');
    expect(guide).toContain('gbrain sources list --json');
    expect(guide).toContain('openclaw-support-kb');
    expect(guide).toContain('do not ask users for an OpenAI API key just to run Eva Brain extraction');
    expect(guide).not.toContain('export OPENAI_API_KEY=');
  });

  test('recurring job docs distinguish local import from git-backed sync', () => {
    const guide = readFileSync(join(root, 'INSTALL_FOR_AGENTS.md'), 'utf8');

    expect(guide).toContain('Local-only brain refresh');
    expect(guide).toContain('gbrain import ~/brain --no-embed && gbrain embed --stale --source default');
    expect(guide).toContain('Git-tracked brain sync');
    expect(guide).toContain('only when `~/brain` has a configured git remote and upstream tracking branch');
    expect(guide).toContain("OpenClaw's scheduler/Minions job path");
    expect(guide).toContain('gbrain embed --stale --source openclaw-support-kb');
  });

  test('OpenClaw extraction route remains plugin-owned and Codex OAuth scoped', () => {
    const plugin = readFileSync(join(root, 'plugins/openclaw-gbrain/index.js'), 'utf8');

    expect(plugin).toContain('GBRAIN_ROUTE_PATH = "/plugins/gbrain/extract"');
    expect(plugin).toContain('protocol: "gbrain.media-extraction.v1"');
    expect(plugin).toContain('GBrain extraction only supports openai-codex/* models');
    expect(plugin).toContain('!resolved.startsWith("openai-codex/")');
    expect(plugin).toContain('invalid_model');
    expect(plugin).not.toContain('OPENAI_API_KEY');
    expect(plugin).not.toContain('refreshToken');
    expect(plugin).not.toContain('accessToken');
  });

  test('OpenClaw plugin keeps source-linked Bun CLI usable under LaunchAgents', () => {
    const plugin = readFileSync(join(root, 'plugins/openclaw-gbrain/index.js'), 'utf8');
    const readme = readFileSync(join(root, 'plugins/openclaw-gbrain/README.md'), 'utf8');

    expect(plugin).toContain('join(homedir(), ".bun", "bin")');
    expect(plugin).toContain('prependPathEntry(basePath, bunBin)');
    expect(plugin).toContain('BUN_INSTALL');
    expect(readme).toContain('LaunchAgents often start with a minimal PATH');
    expect(readme).toContain('Use the source-linked CLI from');
    expect(readme).toContain('Do not point `gbrainBin` at a');
    expect(readme).toContain("PGLite's `pglite.data`");
  });
});
