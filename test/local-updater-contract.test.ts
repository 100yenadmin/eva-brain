import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const tmpHomes: string[] = [];

interface MarketplaceEntry {
  name?: string;
  source: { path: string };
  policy: { installation: string; authentication: string };
}

afterEach(() => {
  while (tmpHomes.length > 0) {
    const dir = tmpHomes.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-install-test-'));
  tmpHomes.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
}

function makeRepoWithEvaTags(home: string, tags: string[]): string {
  const repo = join(home, 'remote-src');
  mkdirSync(repo, { recursive: true });
  runGit(repo, ['init']);
  runGit(repo, ['config', 'user.email', 'agent@example.invalid']);
  runGit(repo, ['config', 'user.name', 'Agent']);
  writeFileSync(join(repo, 'README.md'), '# tagged repo\n');
  runGit(repo, ['add', 'README.md']);
  runGit(repo, ['commit', '-m', 'initial']);
  runGit(repo, ['branch', '-M', 'master']);
  for (const tag of tags) {
    writeFileSync(join(repo, 'README.md'), `# tagged repo\n${tag}\n`);
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', `release ${tag}`]);
    runGit(repo, ['tag', tag]);
  }
  return repo;
}

function makeSupportKbRepo(home: string): string {
  const repo = join(home, 'support-kb-src');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# support kb\n');
  writeFileSync(join(repo, 'scripts/update-client.mjs'), 'console.log("update-client ok");\n');
  writeFileSync(join(repo, 'scripts/status.mjs'), 'console.log("status ok");\n');
  runGit(repo, ['init']);
  runGit(repo, ['config', 'user.email', 'agent@example.invalid']);
  runGit(repo, ['config', 'user.name', 'Agent']);
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'initial support kb']);
  return repo;
}

function writeFakeInstallBins(home: string, cycleExit: 'unknown' | 'other'): void {
  const binDir = join(home, '.bun/bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'bun'),
    '#!/usr/bin/env bash\nexit 0\n',
  );
  writeFileSync(
    join(binDir, 'gbrain'),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "init" ]; then
  exit 0
fi
if [ "\${1:-}" = "sync" ]; then
  exit 0
fi
if [ "\${1:-}" = "embed" ]; then
  exit 0
fi
if [ "\${1:-}" = "sources" ] && [ "\${2:-}" = "cycle-freshness" ]; then
  if [ "${cycleExit}" = "unknown" ]; then
    echo "Unknown sources subcommand: cycle-freshness" >&2
  else
    echo "Unknown sources subcommand: cycle-freshness; database locked while updating source freshness" >&2
  fi
  exit 2
fi
if [ "\${1:-}" = "sources" ] && [ "\${2:-}" = "sync-freshness" ]; then
  if [ "${cycleExit}" = "unknown" ]; then
    echo "Unknown sources subcommand: sync-freshness" >&2
  else
    echo "Unknown sources subcommand: sync-freshness; database locked while updating source freshness" >&2
  fi
  exit 2
fi
exit 0
`,
  );
  chmodSync(join(binDir, 'bun'), 0o755);
  chmodSync(join(binDir, 'gbrain'), 0o755);
}

describe('public local updater and Codex plugin packaging', () => {
  test('update script is public-host phrased and syntax-valid', () => {
    const script = readFileSync(join(root, 'scripts/update-local-install.sh'), 'utf8');

    expect(script).toMatch(/Usage:\s+scripts\/update-local-install\.sh\s+\[options\]/);
    expect(script).toMatch(/REF="\$\{EVA_BRAIN_REF:-stable\}"/);
    expect(script).toMatch(/latest_stable_tag\(\)/);
    expect(script).toMatch(/git\s+ls-remote\s+--tags\s+--refs\s+--sort='version:refname'\s+"\$REPO_URL"\s+'eva-v\*'/);
    expect(script).toMatch(/No Eva Brain release tags found/);
    expect(script).toMatch(/--with-openclaw\b/);
    expect(script).toMatch(/--with-codex-plugin\b/);
    expect(script).toMatch(/--with-support-kb\b/);
    expect(script).toMatch(/--with-workspace-docs\b/);
    expect(script).toMatch(/--skip-health\b/);
    expect(script).toMatch(/node\s+scripts\/install-codex-plugin\.mjs/);
    expect(script).toMatch(/node\s+scripts\/eva-brain-health\.mjs/);
    expect(script).toContain('health_args+=(--require-openclaw)');
    expect(script).toContain('health_args+=(--require-support-kb)');
    expect(script).toContain('health_args+=(--allow-missing-support-kb)');
    expect(script).toMatch(/pgrep\s+-f\s+'\[g\]brain serve'/);
    expect(script).toMatch(/pgrep\s+-f\s+'\[l\]aunch-gbrain-serve\\\.mjs'/);
    expect(script).toMatch(/kill\s+-KILL\s+\$pids/);
    expect(script).toMatch(/Stale gbrain serve\/plugin launcher processes remain after cleanup/);
    expect(script).toMatch(/switch\s+--detach\s+FETCH_HEAD/);
    expect(script).toMatch(/GBRAIN_ROOT="\$\{GBRAIN_HOME:-\$HOME\}"/);
    expect(script).toMatch(/GBRAIN_DIR="\$GBRAIN_ROOT\/\.gbrain"/);
    expect(script).toMatch(/GBRAIN_ENV_FILE="\$\{GBRAIN_ENV_FILE:-\$GBRAIN_DIR\/gbrain\.env\}"/);
    expect(script).toContain('load_gbrain_env');
    expect(script).toContain('ORIGINAL_ARGS=("$@")');
    expect(script).toContain('reexec_from_checked_out_updater');
    expect(script).toContain('EVA_BRAIN_UPDATER_REEXECED=1');
    expect(script).toContain('Skipping $label embedding because');
    expect(script).toContain('WORKSPACE_DOCS_SOURCE="${EVA_BRAIN_WORKSPACE_DOCS_SOURCE:-workspace-docs}"');
    expect(script).toContain('gbrain" import "$WORKSPACE_DOCS_DIR" --source-id "$WORKSPACE_DOCS_SOURCE" --no-embed');
    expect(script).toContain('sources "$freshness_command" "$source_id" off');
    expect(script).toContain('disable_source_sync_freshness_if_supported "$WORKSPACE_DOCS_SOURCE"');
    expect(script).toMatch(/config_path="\$GBRAIN_DIR\/config\.json"/);
    expect(script).toMatch(/stop_stale_serve_if_requested\s*\n\s*local config_path="\$GBRAIN_DIR\/config\.json"/);
    expect(script).toMatch(/init\s+--pglite\s+--embedding-model\s+voyage:voyage-4-large\s+--embedding-dimensions\s+2048/);
    expect(script).toMatch(/if \[ -f "\$config_path" \]; then/);
    expect(script).toMatch(/run "\$HOME\/\.bun\/bin\/gbrain" init/);
    expect(script).not.toMatch(/\bfleet\b/i);

    const health = readFileSync(join(root, 'scripts/eva-brain-health.mjs'), 'utf8');
    expect(health).toContain('supportKbPages');
    expect(health).toContain('workspaceDocsPages');
    expect(health).toContain('bySource');
    expect(health).toContain('openclaw-support-kb');
    expect(health).toContain('workspace-docs');
    expect(health).toContain("process.argv.includes('--require-openclaw')");
    expect(health).toContain("process.argv.includes('--require-support-kb')");
    expect(health).toContain("process.argv.includes('--allow-missing-support-kb')");
    expect(health).toContain("process.argv.includes('--require-workspace-docs')");
    expect(health).toContain('!requireOpenClaw || pluginInspect.ok');

    const result = Bun.spawnSync({
      cmd: ['bash', '-n', 'scripts/update-local-install.sh'],
      cwd: root,
    });
    expect(result.exitCode).toBe(0);
  });

  test('release workflow publishes only eva-v tags with binaries and checksums', () => {
    const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

    expect(workflow).toMatch(/tags:\s+\['eva-v\*'\]/);
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toContain('tag_name:');
    expect(workflow).toContain('gbrain-darwin-arm64');
    expect(workflow).toContain('gbrain-linux-x64');
    expect(workflow).toContain('SHA256SUMS');
    expect(workflow).toContain('timeout-minutes: 20');
    expect(workflow).toContain('bun run build:openclaw');
    expect(workflow).toContain('basename "$file"');
    expect(workflow).not.toContain('- run: bun test');
    expect(workflow).not.toContain('xargs -0 sha256sum > SHA256SUMS');
    expect(workflow).toMatch(/tag_name:\s+\$\{\{\s*env\.RELEASE_TAG\s*\}\}/);
    expect(workflow).toContain('Release tags must use eva-v*');
    expect(workflow).toContain('Validate release tag matches package version');
    expect(workflow).toContain("require('./package.json').version");
    expect(workflow).toContain('Release tag must match package.json version');
  });

  test('test workflow uses OSS gitleaks CLI without an organization license secret', () => {
    const workflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');

    expect(workflow).toContain('Install gitleaks OSS CLI');
    expect(workflow).toContain('gitleaks dir . --redact --no-banner');
    expect(workflow).toContain('gitleaks git . --redact --no-banner --log-opts="${BASE_SHA}..${HEAD_SHA}"');
    expect(workflow).not.toContain('gitleaks/gitleaks-action');
    expect(workflow).not.toContain('GITLEAKS_LICENSE');
  });

  test('Codex plugin metadata stays repo-owned and version-aligned', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const skillManifest = JSON.parse(readFileSync(join(root, 'skills/manifest.json'), 'utf8'));
    const codexPlugin = JSON.parse(readFileSync(join(root, 'plugins/gbrain-codex/.codex-plugin/plugin.json'), 'utf8'));
    const codexPkg = JSON.parse(readFileSync(join(root, 'plugins/gbrain-codex/package.json'), 'utf8'));

    expect(codexPlugin.name).toBe('gbrain-codex');
    expect(codexPlugin.version).toBe(pkg.version);
    expect(codexPkg.version).toBe(pkg.version);
    expect(skillManifest.version).toBe(pkg.version);
    expect(codexPlugin.repository).toContain('electricsheephq/eva-brain');
    expect(codexPlugin.skills).toBe('./skills/');
    expect(codexPlugin.mcpServers).toBe('./.mcp.json');
    expect(readFileSync(join(root, 'scripts/codex-gbrain-smoke.mjs'), 'utf8')).toContain('collectCacheVersions');
  });

  test('Codex plugin is not an OpenClaw plugin child by accident', () => {
    expect(existsSync(join(root, 'plugins/gbrain-codex/openclaw.plugin.json'))).toBe(false);

    const mcp = JSON.parse(readFileSync(join(root, 'plugins/gbrain-codex/.mcp.json'), 'utf8'));
    expect(mcp.mcpServers['gbrain-codex'].command).toBe('node');
    expect(mcp.mcpServers['gbrain-codex'].args).toContain('./scripts/launch-gbrain-serve.mjs');
  });

  test('Codex plugin rehearsal is provider-key independent', () => {
    const rehearsal = readFileSync(join(root, 'plugins/gbrain-codex/scripts/rehearsal.mjs'), 'utf8');
    expect(rehearsal).toContain("'--no-embedding'");
    expect(rehearsal).toMatch(/function ensureTempBrain[\s\S]*rehearsalInitArgs\(\)/);
  });

  test('Codex launcher reaps gbrain serve when stdio transport closes', async () => {
    const launcherModulePath = '../plugins/gbrain-codex/scripts/launch-gbrain-serve.mjs';
    const { bindChildLifecycle } = await import(launcherModulePath) as {
      bindChildLifecycle: (
        child: EventEmitter & { exitCode: number | null; signalCode: string | null; killed: boolean; kill: (signal: string) => boolean },
        opts: { parentProcess: EventEmitter; stdin: EventEmitter; forceKillAfterMs: number },
      ) => () => void;
    };
    const parentProcess = new EventEmitter();
    const stdin = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: string | null;
      killed: boolean;
      kills: string[];
      kill: (signal: string) => boolean;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kills = [];
    child.kill = (signal: string) => {
      child.kills.push(signal);
      child.killed = true;
      return true;
    };

    const cleanup = bindChildLifecycle(child, {
      parentProcess,
      stdin,
      forceKillAfterMs: 5,
    });
    stdin.emit('close');
    cleanup();

    expect(child.kills).toEqual(['SIGTERM']);
    expect(parentProcess.listenerCount('SIGTERM')).toBe(0);
  });

  test('Codex launcher escalates to SIGKILL when gbrain serve ignores SIGTERM', async () => {
    const launcherModulePath = '../plugins/gbrain-codex/scripts/launch-gbrain-serve.mjs';
    const { bindChildLifecycle } = await import(launcherModulePath) as {
      bindChildLifecycle: (
        child: EventEmitter & { exitCode: number | null; signalCode: string | null; killed: boolean; kill: (signal: string) => boolean },
        opts: { parentProcess: EventEmitter; stdin: EventEmitter; forceKillAfterMs: number },
      ) => () => void;
    };
    const parentProcess = new EventEmitter();
    const stdin = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: string | null;
      killed: boolean;
      kills: string[];
      kill: (signal: string) => boolean;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kills = [];
    child.kill = (signal: string) => {
      child.kills.push(signal);
      child.killed = true;
      return true;
    };

    const cleanup = bindChildLifecycle(child, {
      parentProcess,
      stdin,
      forceKillAfterMs: 5,
    });
    stdin.emit('close');
    await new Promise(resolve => setTimeout(resolve, 15));
    cleanup();

    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('Codex installer creates a local plugin shell linked to current repo skills', () => {
    const home = tempHome();
    const result = Bun.spawnSync({
      cmd: ['node', 'scripts/install-codex-plugin.mjs', '--home', home, '--repo-dir', root],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);

    const pluginDir = join(home, 'plugins/gbrain-codex');
    expect(existsSync(join(pluginDir, '.codex-plugin/plugin.json'))).toBe(true);
    expect(existsSync(join(pluginDir, '.mcp.json'))).toBe(true);
    expect(lstatSync(join(pluginDir, 'skills')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginDir, 'skills'))).toBe(join(root, 'skills'));

    const marketplace = JSON.parse(readFileSync(join(home, '.agents/plugins/marketplace.json'), 'utf8'));
    const entry = marketplace.plugins.find((plugin: MarketplaceEntry) => plugin.name === 'gbrain-codex') as MarketplaceEntry | undefined;
    expect(entry).toBeTruthy();
    if (!entry) throw new Error('gbrain-codex marketplace entry missing');
    expect(entry.source.path).toBe('./plugins/gbrain-codex');
    expect(entry.policy.installation).toBe('AVAILABLE');
    expect(entry.policy.authentication).toBe('ON_INSTALL');

    const codexConfig = readFileSync(join(home, '.codex/config.toml'), 'utf8');
    expect(codexConfig).toContain('[marketplaces.local-workspace]');
    expect(codexConfig).toContain(`source = ${JSON.stringify(home)}`);
    expect(codexConfig).toContain('[plugins."gbrain-codex@local-workspace"]');
    expect(codexConfig).toContain('enabled = true');

    const rehearsal = Bun.spawnSync({
      cmd: ['node', join(pluginDir, 'scripts/rehearsal.mjs')],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        DASHSCOPE_API_KEY: 'invalid-key-for-provider-independent-rehearsal',
      },
    });
    expect(rehearsal.exitCode).toBe(0);
    expect(JSON.parse(rehearsal.stdout.toString()).ok).toBe(true);
  }, 15000);

  test('Codex installer clears stale cached gbrain-codex plugin versions', () => {
    const home = tempHome();
    const stalePluginDir = join(home, '.codex/plugins/cache/local-workspace/gbrain-codex/0.30.0/.codex-plugin');
    mkdirSync(stalePluginDir, { recursive: true });
    writeFileSync(join(stalePluginDir, 'plugin.json'), JSON.stringify({ name: 'gbrain-codex', version: '0.30.0' }));

    const result = Bun.spawnSync({
      cmd: ['node', 'scripts/install-codex-plugin.mjs', '--home', home, '--repo-dir', root],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, '.codex/plugins/cache/local-workspace/gbrain-codex'))).toBe(false);

    const stdout = JSON.parse(result.stdout.toString());
    expect(stdout.refreshedCaches).toContain(join(home, '.codex/plugins/cache/local-workspace/gbrain-codex'));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(result.stderr.toString()).toContain(`expected: ${pkg.version}`);
  });

  test('Codex installer replaces stale or broken local gbrain-codex symlinks', () => {
    const home = tempHome();
    const pluginDir = join(home, 'plugins/gbrain-codex');
    mkdirSync(join(home, 'plugins'), { recursive: true });
    symlinkSync('/path/that/does/not/exist', pluginDir);
    expect(lstatSync(pluginDir).isSymbolicLink()).toBe(true);

    const result = Bun.spawnSync({
      cmd: ['node', 'scripts/install-codex-plugin.mjs', '--home', home, '--repo-dir', root],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(lstatSync(pluginDir).isDirectory()).toBe(true);
    expect(readlinkSync(join(pluginDir, 'skills'))).toBe(join(root, 'skills'));
  });

  test('Codex installer dry-run does not create home plugin files', () => {
    const home = tempHome();
    const result = Bun.spawnSync({
      cmd: ['node', 'scripts/install-codex-plugin.mjs', '--home', home, '--repo-dir', root, '--dry-run'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, 'plugins/gbrain-codex'))).toBe(false);
    expect(existsSync(join(home, '.agents/plugins/marketplace.json'))).toBe(false);
  });

  test('local updater stable dry-run resolves the newest eva-v release tag', () => {
    const home = tempHome();
    const repo = makeRepoWithEvaTags(home, ['eva-v0.40.1.0', 'eva-v0.40.2.0']);
    const installDir = join(home, 'eva-brain');
    const result = Bun.spawnSync({
      cmd: [
        'bash',
        'scripts/update-local-install.sh',
        '--dry-run',
        '--repo',
        repo,
        '--dir',
        installDir,
        '--without-openclaw',
        '--without-codex-plugin',
        '--skip-provider-test',
        '--skip-doctor',
      ],
      cwd: root,
      env: { ...process.env, HOME: home, GBRAIN_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).toContain('Resolved stable to eva-v0.40.2.0');
    expect(stdout).toContain(`git clone --branch eva-v0.40.2.0 ${repo} ${installDir}`);
    expect(stdout).not.toContain('--branch master');
    expect(existsSync(installDir)).toBe(false);
  });

  test('local updater fails closed when stable has no eva-v release tags', () => {
    const home = tempHome();
    const repo = makeRepoWithEvaTags(home, []);
    const result = Bun.spawnSync({
      cmd: [
        'bash',
        'scripts/update-local-install.sh',
        '--dry-run',
        '--repo',
        repo,
        '--dir',
        join(home, 'eva-brain'),
        '--without-openclaw',
        '--without-codex-plugin',
        '--skip-provider-test',
        '--skip-doctor',
      ],
      cwd: root,
      env: { ...process.env, HOME: home, GBRAIN_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(1);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).toContain('No Eva Brain release tags found');
    expect(stderr).toContain('pass --ref master for a development install');
  });

  test('local updater dry-run still allows explicit master development installs', () => {
    const home = tempHome();
    const installDir = join(home, 'eva-brain');
    const result = Bun.spawnSync({
      cmd: [
        'bash',
        'scripts/update-local-install.sh',
        '--dry-run',
        '--ref',
        'master',
        '--dir',
        installDir,
        '--without-openclaw',
        '--without-codex-plugin',
        '--skip-provider-test',
        '--skip-doctor',
      ],
      cwd: root,
      env: { ...process.env, HOME: home, GBRAIN_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stdout).toContain(`git clone --branch master https://github.com/electricsheephq/eva-brain.git ${installDir}`);
    expect(stdout).toContain('bun install');
    expect(stdout).toContain('gbrain init --pglite --embedding-model voyage:voyage-4-large --embedding-dimensions 2048');
    expect(stderr).toContain('Dry-run: install dir does not exist yet');
    expect(existsSync(installDir)).toBe(false);
  });

  test('local updater restores missing Bun-global gbrain shim from checked-out CLI', () => {
    const home = tempHome();
    const repo = makeRepoWithEvaTags(home, []);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'src/cli.ts'),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "init" ]; then
  exit 0
fi
if [ "\${1:-}" = "version" ]; then
  echo "gbrain test"
  exit 0
fi
echo "unexpected gbrain args: $*" >&2
exit 3
`,
    );
    chmodSync(join(repo, 'src/cli.ts'), 0o755);
    runGit(repo, ['add', 'src/cli.ts']);
    runGit(repo, ['commit', '-m', 'add fake cli']);

    const binDir = join(home, '.bun/bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'bun'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(binDir, 'bun'), 0o755);

    const installDir = join(home, 'eva-brain');
    const result = Bun.spawnSync({
      cmd: [
        'bash',
        'scripts/update-local-install.sh',
        '--ref',
        'master',
        '--repo',
        repo,
        '--dir',
        installDir,
        '--without-openclaw',
        '--without-codex-plugin',
        '--without-workspace-docs',
        '--skip-provider-test',
        '--skip-doctor',
        '--skip-health',
      ],
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        GBRAIN_HOME: home,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(0);
    expect(stderr).toContain('Restoring missing gbrain CLI shim');
    expect(lstatSync(join(binDir, 'gbrain')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(binDir, 'gbrain'))).toBe(join(installDir, 'src/cli.ts'));
  });

  test('local updater archives dirty Support KB checkouts before reinstalling', () => {
    const home = tempHome();
    const repo = makeRepoWithEvaTags(home, []);
    const kbRepo = makeRepoWithEvaTags(tempHome(), []);
    const kbDir = join(home, '.gbrain/sources/openclaw-support-kb');
    mkdirSync(kbDir, { recursive: true });
    runGit(kbDir, ['init']);
    runGit(kbDir, ['config', 'user.email', 'agent@example.invalid']);
    runGit(kbDir, ['config', 'user.name', 'Agent']);
    writeFileSync(join(kbDir, 'kb-manifest.json'), '{}\n');
    runGit(kbDir, ['add', 'kb-manifest.json']);
    runGit(kbDir, ['commit', '-m', 'initial kb']);
    writeFileSync(join(kbDir, 'kb-manifest.json'), '{"dirty":true}\n');
    writeFileSync(join(kbDir, 'local-only.md'), '# local only\n');

    const result = Bun.spawnSync({
      cmd: [
        'bash',
        'scripts/update-local-install.sh',
        '--dry-run',
        '--ref',
        'master',
        '--repo',
        repo,
        '--dir',
        join(home, 'eva-brain'),
        '--with-support-kb',
        '--without-openclaw',
        '--without-codex-plugin',
        '--skip-provider-test',
        '--skip-doctor',
      ],
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        GBRAIN_HOME: home,
        OPENCLAW_SUPPORT_KB_DIR: kbDir,
        OPENCLAW_SUPPORT_KB_REPO: kbRepo,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).toContain('Support KB checkout has local changes; archiving it');
    expect(stderr).toContain('Dry-run: skipping optional cycle-freshness disable execution');
    expect(stdout).toContain(`mv ${kbDir}`);
    expect(stdout).toContain(`git clone ${kbRepo} ${kbDir}`);
    expect(stdout).not.toContain(`git -C ${kbDir} pull --ff-only`);
  });

  test('local updater treats missing cycle-freshness support as optional during real support KB install', () => {
    const home = tempHome();
    const repo = makeRepoWithEvaTags(home, []);
    const kbRepo = makeSupportKbRepo(tempHome());
    writeFakeInstallBins(home, 'unknown');

    const result = Bun.spawnSync({
      cmd: [
        'bash',
        'scripts/update-local-install.sh',
        '--ref',
        'master',
        '--repo',
        repo,
        '--dir',
        join(home, 'eva-brain'),
        '--with-support-kb',
        '--without-openclaw',
        '--without-codex-plugin',
        '--skip-provider-test',
        '--skip-doctor',
        '--skip-health',
      ],
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${join(home, '.bun/bin')}:${process.env.PATH ?? ''}`,
        GBRAIN_HOME: home,
        OPENCLAW_SUPPORT_KB_REPO: kbRepo,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(0);
    expect(stderr).toContain("Skipping cycle-freshness disable; installed gbrain does not expose 'sources cycle-freshness'.");
  });

  test('local updater skips Support KB embedding on no-key Voyage installs', () => {
    const home = tempHome();
    const repo = makeRepoWithEvaTags(home, []);
    const kbRepo = makeSupportKbRepo(tempHome());
    const binDir = join(home, '.bun/bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'bun'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(
      join(binDir, 'gbrain'),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "init" ]; then
  mkdir -p "$HOME/.gbrain"
  printf '{"embedding_model":"voyage:voyage-4-large"}\\n' > "$HOME/.gbrain/config.json"
  exit 0
fi
if [ "\${1:-}" = "sync" ]; then
  exit 0
fi
if [ "\${1:-}" = "embed" ]; then
  echo "embed should have been skipped when VOYAGE_API_KEY is missing" >&2
  exit 9
fi
if [ "\${1:-}" = "sources" ] && [ "\${2:-}" = "cycle-freshness" ]; then
  echo "cycle disabled"
  exit 0
fi
if [ "\${1:-}" = "sources" ] && [ "\${2:-}" = "sync-freshness" ]; then
  echo "sync disabled"
  exit 0
fi
exit 0
`,
    );
    chmodSync(join(binDir, 'bun'), 0o755);
    chmodSync(join(binDir, 'gbrain'), 0o755);

    const result = Bun.spawnSync({
      cmd: [
        'bash',
        'scripts/update-local-install.sh',
        '--ref',
        'master',
        '--repo',
        repo,
        '--dir',
        join(home, 'eva-brain'),
        '--with-support-kb',
        '--without-openclaw',
        '--without-codex-plugin',
        '--skip-provider-test',
        '--skip-doctor',
        '--skip-health',
      ],
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${join(home, '.bun/bin')}:${process.env.PATH ?? ''}`,
        GBRAIN_HOME: home,
        OPENCLAW_SUPPORT_KB_REPO: kbRepo,
        VOYAGE_API_KEY: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(0);
    expect(stderr).toContain('Skipping Support KB embedding because voyage:voyage-4-large requires VOYAGE_API_KEY');
    expect(stderr).not.toContain('embed should have been skipped');
  });

  test('local updater can register and import canonical OpenClaw workspace docs', () => {
    const home = tempHome();
    const repo = makeRepoWithEvaTags(home, []);
    const docsDir = join(home, '.openclaw/workspace/docs');
    mkdirSync(join(docsDir, 'runbooks'), { recursive: true });
    writeFileSync(join(docsDir, 'runbooks/customer-vm.md'), '# Customer VM Runbook\n');
    const binDir = join(home, '.bun/bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'bun'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(
      join(binDir, 'gbrain'),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "init" ]; then
  mkdir -p "$HOME/.gbrain"
  printf '{"embedding_model":"voyage:voyage-4-large"}\\n' > "$HOME/.gbrain/config.json"
  exit 0
fi
if [ "\${1:-}" = "sources" ] && [ "\${2:-}" = "list" ]; then
  printf '{"sources":[]}\\n'
  exit 0
fi
if [ "\${1:-}" = "sources" ] && [ "\${2:-}" = "add" ]; then
  exit 0
fi
if [ "\${1:-}" = "sources" ] && [ "\${2:-}" = "cycle-freshness" ]; then
  echo "cycle disabled"
  exit 0
fi
if [ "\${1:-}" = "sources" ] && [ "\${2:-}" = "sync-freshness" ]; then
  echo "sync disabled"
  exit 0
fi
if [ "\${1:-}" = "import" ]; then
  exit 0
fi
if [ "\${1:-}" = "embed" ]; then
  echo "workspace embed should have been skipped when VOYAGE_API_KEY is missing" >&2
  exit 9
fi
exit 0
`,
    );
    chmodSync(join(binDir, 'bun'), 0o755);
    chmodSync(join(binDir, 'gbrain'), 0o755);

    const result = Bun.spawnSync({
      cmd: [
        'bash',
        'scripts/update-local-install.sh',
        '--ref',
        'master',
        '--repo',
        repo,
        '--dir',
        join(home, 'eva-brain'),
        '--with-workspace-docs',
        '--without-openclaw',
        '--without-codex-plugin',
        '--skip-provider-test',
        '--skip-doctor',
        '--skip-health',
      ],
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${join(home, '.bun/bin')}:${process.env.PATH ?? ''}`,
        GBRAIN_HOME: home,
        VOYAGE_API_KEY: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain(`gbrain sources add workspace-docs --path ${docsDir}`);
    expect(stdout).toContain(`gbrain import ${docsDir} --source-id workspace-docs --no-embed`);
    expect(stdout).toContain('gbrain sources sync-freshness workspace-docs off');
    expect(stderr).toContain('Skipping Workspace docs embedding because voyage:voyage-4-large requires VOYAGE_API_KEY');
    expect(stderr).not.toContain('workspace embed should have been skipped');
  });

  test('local updater still fails non-compatibility cycle-freshness errors', () => {
    const home = tempHome();
    const repo = makeRepoWithEvaTags(home, []);
    const kbRepo = makeSupportKbRepo(tempHome());
    writeFakeInstallBins(home, 'other');

    const result = Bun.spawnSync({
      cmd: [
        'bash',
        'scripts/update-local-install.sh',
        '--ref',
        'master',
        '--repo',
        repo,
        '--dir',
        join(home, 'eva-brain'),
        '--with-support-kb',
        '--without-openclaw',
        '--without-codex-plugin',
        '--skip-provider-test',
        '--skip-doctor',
        '--skip-health',
      ],
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${join(home, '.bun/bin')}:${process.env.PATH ?? ''}`,
        GBRAIN_HOME: home,
        OPENCLAW_SUPPORT_KB_REPO: kbRepo,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain('database locked while updating source freshness');
  });

  test('Codex installer rejects missing option values instead of falling back to cwd', () => {
    for (const flag of ['--home', '--repo-dir']) {
      const result = Bun.spawnSync({
        cmd: ['node', 'scripts/install-codex-plugin.mjs', flag],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(new TextDecoder().decode(result.stderr)).toContain(`Missing value for ${flag}`);
    }
  });
});
