#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const CODEX_MARKETPLACE_NAME = 'local-workspace';
const CODEX_PLUGIN_NAME = 'gbrain-codex';
const CODEX_PLUGIN_ID = `${CODEX_PLUGIN_NAME}@${CODEX_MARKETPLACE_NAME}`;

function usage() {
  process.stdout.write(`Usage: node scripts/install-codex-plugin.mjs [options]

Installs or updates the repo-owned gbrain-codex plugin for Codex Desktop by
creating ~/plugins/gbrain-codex and updating ~/.agents/plugins/marketplace.json.

Options:
  --repo-dir <path>       Eva Brain checkout root (default: current repo)
  --home <path>           Home directory to update (default: $HOME)
  --dry-run               Print intended actions without writing
  --force                 Replace an existing non-Eva gbrain-codex directory
  -h, --help              Show this help
`);
}

function parseArgs(argv) {
  const requireValue = (flag, value) => {
    if (!value || value.startsWith('-')) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  const opts = {
    repoDir: REPO_ROOT,
    home: process.env.HOME || '',
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo-dir') opts.repoDir = resolve(requireValue('--repo-dir', argv[++i]));
    else if (arg === '--home') opts.home = resolve(requireValue('--home', argv[++i]));
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!opts.home) throw new Error('Could not resolve home directory. Pass --home <path>.');
  return opts;
}

function log(message) {
  process.stderr.write(`[gbrain-codex:install] ${message}\n`);
}

function runStep(opts, message, fn) {
  log(message);
  if (!opts.dryRun) fn();
}

function assertRepoShape(repoDir) {
  const pluginRoot = join(repoDir, 'plugins', 'gbrain-codex');
  const manifest = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const mcp = join(pluginRoot, '.mcp.json');
  const skills = join(repoDir, 'skills');
  for (const path of [manifest, mcp, skills]) {
    if (!existsSync(path)) throw new Error(`Required path is missing: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  if (parsed.name !== 'gbrain-codex') {
    throw new Error(`Unexpected Codex plugin name in ${manifest}: ${parsed.name}`);
  }
  if (!parsed.version) {
    throw new Error(`Codex plugin manifest is missing version: ${manifest}`);
  }
  return { pluginRoot, manifest, mcp, skills, version: parsed.version };
}

function safeRemovePluginDir(pluginDir, force) {
  let stat;
  try {
    stat = lstatSync(pluginDir);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    rmSync(pluginDir, { force: true });
    return;
  }

  const manifest = join(pluginDir, '.codex-plugin', 'plugin.json');
  if (!force && existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      if (parsed.name === 'gbrain-codex') {
        rmSync(pluginDir, { recursive: true, force: true });
        return;
      }
    } catch {
      // Fall through to the guarded error below.
    }
  }

  if (!force) {
    throw new Error(
      `Refusing to replace existing plugin directory: ${pluginDir}\n` +
      `Pass --force if this directory is safe to replace.`,
    );
  }
  rmSync(pluginDir, { recursive: true, force: true });
}

function linkEntry(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(src, dest);
}

function installPluginTree(opts, paths) {
  const pluginsDir = join(opts.home, 'plugins');
  const pluginDir = join(pluginsDir, 'gbrain-codex');
  runStep(opts, `Installing Codex plugin into ${pluginDir}`, () => {
    mkdirSync(pluginsDir, { recursive: true });
    safeRemovePluginDir(pluginDir, opts.force);
    mkdirSync(pluginDir, { recursive: true });
    linkEntry(join(paths.pluginRoot, '.codex-plugin'), join(pluginDir, '.codex-plugin'));
    linkEntry(join(paths.pluginRoot, '.mcp.json'), join(pluginDir, '.mcp.json'));
    linkEntry(join(paths.pluginRoot, 'README.md'), join(pluginDir, 'README.md'));
    linkEntry(join(paths.pluginRoot, 'assets'), join(pluginDir, 'assets'));
    linkEntry(join(paths.pluginRoot, 'scripts'), join(pluginDir, 'scripts'));
    linkEntry(paths.skills, join(pluginDir, 'skills'));
  });
  return pluginDir;
}

function marketplacePath(home) {
  return join(home, '.agents', 'plugins', 'marketplace.json');
}

function updateMarketplace(opts) {
  const path = marketplacePath(opts.home);
  runStep(opts, `Updating Codex marketplace ${path}`, () => {
    mkdirSync(dirname(path), { recursive: true });
    let doc = { name: 'local', interface: { displayName: 'Local Plugins' }, plugins: [] };
    if (existsSync(path)) {
      doc = JSON.parse(readFileSync(path, 'utf8'));
    }
    if (!Array.isArray(doc.plugins)) doc.plugins = [];
    doc.name = doc.name || 'local';
    doc.interface = doc.interface || { displayName: 'Local Plugins' };
    doc.interface.displayName = doc.interface.displayName || 'Local Plugins';
    const entry = {
      name: 'gbrain-codex',
      source: { source: 'local', path: './plugins/gbrain-codex' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Engineering',
    };
    const idx = doc.plugins.findIndex(plugin => plugin && plugin.name === entry.name);
    if (idx >= 0) doc.plugins[idx] = { ...doc.plugins[idx], ...entry };
    else doc.plugins.push(entry);
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  });
  return path;
}

function tomlValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(String(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertTomlTable(contents, tableName, values) {
  const header = `[${tableName}]`;
  const lines = contents ? contents.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let start = lines.findIndex(line => line.trim() === header);
  if (start === -1) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(header);
    start = lines.length - 1;
  }

  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end += 1;

  const block = lines.slice(start + 1, end);
  for (const [key, value] of Object.entries(values)) {
    const rendered = `${key} = ${tomlValue(value)}`;
    const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    const idx = block.findIndex(line => keyPattern.test(line));
    if (idx >= 0) block[idx] = rendered;
    else block.push(rendered);
  }

  lines.splice(start + 1, end - start - 1, ...block);
  return `${lines.join('\n')}\n`;
}

function updateCodexConfig(opts) {
  const path = join(opts.home, '.codex', 'config.toml');
  runStep(opts, `Updating Codex config ${path}`, () => {
    mkdirSync(dirname(path), { recursive: true });
    let contents = existsSync(path) ? readFileSync(path, 'utf8') : '';
    contents = upsertTomlTable(contents, `marketplaces.${CODEX_MARKETPLACE_NAME}`, {
      last_updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      source_type: 'local',
      source: opts.home,
    });
    contents = upsertTomlTable(contents, `plugins."${CODEX_PLUGIN_ID}"`, {
      enabled: true,
    });
    writeFileSync(path, contents);
  });
  return path;
}

function cachedVersions(pluginCacheDir) {
  try {
    return readdirSync(pluginCacheDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function refreshCodexCache(opts, expectedVersion) {
  const cacheRoot = join(opts.home, '.codex', 'plugins', 'cache');
  if (!existsSync(cacheRoot)) {
    log(`Codex plugin cache not found at ${cacheRoot}; nothing to refresh.`);
    return [];
  }

  const removed = [];
  for (const marketplace of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!marketplace.isDirectory()) continue;
    const pluginCacheDir = join(cacheRoot, marketplace.name, CODEX_PLUGIN_NAME);
    if (!existsSync(pluginCacheDir)) continue;
    const versions = cachedVersions(pluginCacheDir);
    const summary = versions.length > 0 ? versions.join(', ') : 'unknown cached version';
    runStep(
      opts,
      `Refreshing Codex cache ${pluginCacheDir} (cached: ${summary}; expected: ${expectedVersion})`,
      () => rmSync(pluginCacheDir, { recursive: true, force: true }),
    );
    removed.push(pluginCacheDir);
  }
  if (removed.length === 0) {
    log(`No cached ${CODEX_PLUGIN_NAME} plugin entries found under ${cacheRoot}.`);
  }
  return removed;
}

export function installCodexPlugin(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const paths = assertRepoShape(opts.repoDir);
  const pluginDir = installPluginTree(opts, paths);
  const market = updateMarketplace(opts);
  const codexConfig = updateCodexConfig(opts);
  const refreshedCaches = refreshCodexCache(opts, paths.version);
  const rel = relative(opts.home, pluginDir) || pluginDir;
  log(`Installed ${rel}; restart Codex Desktop to reload plugins.`);
  return { pluginDir, marketplace: market, codexConfig, refreshedCaches, dryRun: opts.dryRun };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const result = installCodexPlugin();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
