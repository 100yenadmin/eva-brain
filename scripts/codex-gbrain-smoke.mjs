#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');

function usage() {
  process.stdout.write(`Usage: node scripts/codex-gbrain-smoke.mjs [options]

Checks the local Codex GBrain plugin install, stale cache state, configured
gbrain search path, and gbrain serve process count.

Options:
  --home <path>                 Home directory to inspect (default: $HOME)
  --query <text>                Configured-home search query (default: OpenClaw)
  --timeout-ms <n>              Per-command timeout (default: 15000)
  --max-serve-processes <n>     Max live serve/launcher processes (default: 1)
  --skip-configured-search      Skip configured-home gbrain search
  --skip-rehearsal              Skip temp-home Codex plugin rehearsal
  --skip-process-check          Skip live serve process count
  -h, --help                    Show this help
`);
}

function requireValue(flag, value) {
  if (!value || value.startsWith('-')) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parseArgs(argv) {
  const opts = {
    home: process.env.HOME || '',
    query: 'OpenClaw',
    timeoutMs: 15_000,
    maxServeProcesses: 1,
    skipConfiguredSearch: false,
    skipRehearsal: false,
    skipProcessCheck: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--home') opts.home = resolve(requireValue('--home', argv[++i]));
    else if (arg === '--query') opts.query = requireValue('--query', argv[++i]);
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(requireValue('--timeout-ms', argv[++i]));
    else if (arg === '--max-serve-processes') opts.maxServeProcesses = Number(requireValue('--max-serve-processes', argv[++i]));
    else if (arg === '--skip-configured-search') opts.skipConfiguredSearch = true;
    else if (arg === '--skip-rehearsal') opts.skipRehearsal = true;
    else if (arg === '--skip-process-check') opts.skipProcessCheck = true;
    else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!opts.home) throw new Error('Could not resolve home directory. Pass --home <path>.');
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1000) throw new Error('--timeout-ms must be at least 1000');
  if (!Number.isFinite(opts.maxServeProcesses) || opts.maxServeProcesses < 0) throw new Error('--max-serve-processes must be >= 0');
  return opts;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(command, args, { cwd = REPO_ROOT, env = process.env, timeoutMs }) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function collectCacheVersions(home) {
  const cacheRoot = join(home, '.codex', 'plugins', 'cache');
  const results = [];
  if (!existsSync(cacheRoot)) return results;
  for (const marketplace of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!marketplace.isDirectory()) continue;
    const pluginDir = join(cacheRoot, marketplace.name, 'gbrain-codex');
    if (!existsSync(pluginDir)) continue;
    for (const version of readdirSync(pluginDir, { withFileTypes: true })) {
      if (!version.isDirectory()) continue;
      const manifest = join(pluginDir, version.name, '.codex-plugin', 'plugin.json');
      let manifestVersion = version.name;
      if (existsSync(manifest)) {
        try {
          manifestVersion = readJson(manifest).version || manifestVersion;
        } catch {
          manifestVersion = `${manifestVersion} (unreadable manifest)`;
        }
      }
      results.push({ marketplace: marketplace.name, dirVersion: version.name, manifestVersion, path: join(pluginDir, version.name) });
    }
  }
  return results;
}

function liveServeProcesses(timeoutMs) {
  const result = run('ps', ['-axo', 'pid,ppid,command'], { timeoutMs });
  if (result.status !== 0) {
    throw new Error(`ps failed: ${result.stderr || result.stdout || 'no output'}`);
  }
  return result.stdout
    .split('\n')
    .filter(line => /[g]brain serve|[l]aunch-gbrain-serve\.mjs/.test(line))
    .map(line => line.trim())
    .filter(Boolean);
}

function assertCommandOk(label, result) {
  if (result.error && result.error.code === 'ETIMEDOUT') {
    throw new Error(`${label} timed out`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout || 'no output'}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const failures = [];
  const rootPkg = readJson(join(REPO_ROOT, 'package.json'));
  const repoPlugin = readJson(join(REPO_ROOT, 'plugins', 'gbrain-codex', '.codex-plugin', 'plugin.json'));

  if (repoPlugin.version !== rootPkg.version) {
    failures.push(`repo plugin version ${repoPlugin.version} does not match root ${rootPkg.version}`);
  }

  const installedManifest = join(opts.home, 'plugins', 'gbrain-codex', '.codex-plugin', 'plugin.json');
  if (!existsSync(installedManifest)) {
    failures.push(`installed Codex plugin manifest missing: ${installedManifest}`);
  } else {
    const installed = readJson(installedManifest);
    if (installed.version !== rootPkg.version) {
      failures.push(`installed Codex plugin version ${installed.version} does not match root ${rootPkg.version}`);
    }
  }

  for (const cache of collectCacheVersions(opts.home)) {
    if (cache.manifestVersion !== rootPkg.version || cache.dirVersion !== rootPkg.version) {
      failures.push(`stale Codex cache ${cache.path}: dir=${cache.dirVersion}, manifest=${cache.manifestVersion}, expected=${rootPkg.version}`);
    }
  }

  if (!opts.skipProcessCheck) {
    try {
      const live = liveServeProcesses(opts.timeoutMs);
      if (live.length > opts.maxServeProcesses) {
        failures.push(`too many live gbrain serve/plugin launcher processes (${live.length} > ${opts.maxServeProcesses}):\n${live.join('\n')}`);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!opts.skipRehearsal) {
    const result = run('node', ['plugins/gbrain-codex/scripts/rehearsal.mjs'], { timeoutMs: Math.max(opts.timeoutMs, 20_000) });
    try {
      assertCommandOk('Codex plugin rehearsal', result);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!opts.skipConfiguredSearch) {
    const gbrain = process.env.GBRAIN_BIN || join(opts.home, '.bun', 'bin', 'gbrain');
    const command = existsSync(gbrain) ? gbrain : 'gbrain';
    const result = run(command, ['search', opts.query, '--limit', '3'], {
      timeoutMs: opts.timeoutMs,
      env: {
        ...process.env,
        PATH: `${join(opts.home, '.bun', 'bin')}:${process.env.PATH || ''}`,
      },
    });
    try {
      assertCommandOk(`configured gbrain search (${opts.query})`, result);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  const output = {
    ok: failures.length === 0,
    version: rootPkg.version,
    failures,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (failures.length > 0) process.exit(1);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
