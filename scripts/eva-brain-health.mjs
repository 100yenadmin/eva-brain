#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SUPPORT_KB_SOURCE = 'openclaw-support-kb';
const SUPPORT_KB_QUERY = 'OpenClaw';
const WORKSPACE_DOCS_SOURCE = process.env.EVA_BRAIN_WORKSPACE_DOCS_SOURCE || 'workspace-docs';
const WORKSPACE_DOCS_QUERY = process.env.EVA_BRAIN_WORKSPACE_DOCS_QUERY || 'runbooks';
const DEFAULT_TIMEOUT_MS = 30_000;
const CANONICAL_WORKSPACE_DOCS_PATH = '/root/.openclaw/workspace/docs';
const CANONICAL_WORKSPACE_RUNBOOKS_PATH = '/root/.openclaw/workspace/docs/runbooks';

const requireOpenClaw = process.argv.includes('--require-openclaw') || process.env.EVA_BRAIN_REQUIRE_OPENCLAW === 'true';
const allowMissingSupportKb = process.argv.includes('--allow-missing-support-kb') || process.env.EVA_BRAIN_ALLOW_MISSING_SUPPORT_KB === 'true';
const requireSupportKb = process.argv.includes('--require-support-kb') || !allowMissingSupportKb;
const requireWorkspaceDocs = process.argv.includes('--require-workspace-docs') || process.env.EVA_BRAIN_REQUIRE_WORKSPACE_DOCS === 'true';
const requireAgentsDocsGuidance = process.argv.includes('--require-agents-docs-guidance') || process.env.EVA_BRAIN_REQUIRE_AGENTS_DOCS_GUIDANCE === 'true' || requireWorkspaceDocs;

function resolveBin(envName, fallback) {
  const configured = process.env[envName];
  if (configured) return configured;
  const bunLinked = join(homedir(), '.bun', 'bin', fallback);
  return existsSync(bunLinked) ? bunLinked : fallback;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return {
    command: [command, ...args].join(' '),
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
  };
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function addWorkspaceAgentsFile(files, workspace) {
  if (typeof workspace !== 'string' || !workspace.trim()) return;
  files.add(join(workspace.trim(), 'AGENTS.md'));
}

function collectAgentHintFiles() {
  const files = new Set();
  if (process.env.OPENCLAW_AGENTS_FILE) files.add(process.env.OPENCLAW_AGENTS_FILE);
  files.add(join(homedir(), '.openclaw', 'AGENTS.md'));
  files.add(join(homedir(), '.openclaw', 'workspace', 'AGENTS.md'));

  const configPath = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), '.openclaw', 'openclaw.json');
  const config = readJsonFile(configPath);
  addWorkspaceAgentsFile(files, config?.workspace);
  addWorkspaceAgentsFile(files, config?.agents?.defaults?.workspace);
  addWorkspaceAgentsFile(files, config?.agents?.default?.workspace);
  const agents = Array.isArray(config?.agents?.list)
    ? config.agents.list
    : config?.agents && typeof config.agents === 'object'
      ? Object.values(config.agents).filter(value => value && typeof value === 'object')
      : [];
  for (const agent of agents) addWorkspaceAgentsFile(files, agent?.workspace);

  return [...files];
}

function checkAgentsDocsGuidance() {
  const checked = collectAgentHintFiles().map(file => {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return {
        file,
        exists: false,
        hasWorkspaceDocsSource: false,
        hasCanonicalDocsPath: false,
        hasCanonicalRunbooksPath: false,
      };
    }
    return {
      file,
      exists: true,
      hasWorkspaceDocsSource: text.includes(WORKSPACE_DOCS_SOURCE),
      hasCanonicalDocsPath: text.includes(CANONICAL_WORKSPACE_DOCS_PATH),
      hasCanonicalRunbooksPath: text.includes(CANONICAL_WORKSPACE_RUNBOOKS_PATH),
    };
  });
  const matching = checked.filter(item =>
    item.exists &&
    item.hasWorkspaceDocsSource &&
    item.hasCanonicalDocsPath &&
    item.hasCanonicalRunbooksPath,
  );
  return {
    required: requireAgentsDocsGuidance,
    ok: matching.length > 0,
    expectedSource: WORKSPACE_DOCS_SOURCE,
    expectedDocsPath: CANONICAL_WORKSPACE_DOCS_PATH,
    expectedRunbooksPath: CANONICAL_WORKSPACE_RUNBOOKS_PATH,
    matchingFiles: matching.map(item => item.file),
    checked,
  };
}

function normalizeSources(value) {
  const rawSources = Array.isArray(value) ? value : Array.isArray(value?.sources) ? value.sources : [];
  return rawSources.map(source => {
    const id = String(source.id ?? source.source_id ?? source.sourceId ?? source.name ?? 'unknown');
    const pages = Number(source.page_count ?? source.pageCount ?? source.pages ?? 0);
    const chunks = Number(source.chunk_count ?? source.chunkCount ?? source.chunks ?? 0);
    const localPath = source.local_path ?? source.localPath ?? null;
    return {
      id,
      pages: Number.isFinite(pages) ? pages : 0,
      chunks: Number.isFinite(chunks) ? chunks : 0,
      localPath: typeof localPath === 'string' && localPath.trim() ? localPath : null,
    };
  });
}

function summarizeSearch(result) {
  const parsed = parseJson(result.stdout, undefined);
  const hits = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
  const textHits = hits.length > 0
    ? hits.length
    : result.stdout.split(/\r?\n/u).filter(line => /^\[[0-9.]+\]\s+/u.test(line)).length;
  return {
    ok: result.ok,
    resultCount: textHits,
    command: result.command,
    stderr: result.ok ? '' : result.stderr.trim(),
  };
}

function walkMarkdownFiles(dir, limit = 12) {
  const files = [];
  const stack = [dir];
  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) stack.push(path);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(path);
        if (files.length >= limit) break;
      }
    }
  }
  return files;
}

function queryFromMarkdownFile(file) {
  let text = '';
  try {
    if (!statSync(file).isFile()) return null;
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const heading = text.split(/\r?\n/u)
    .map(line => line.replace(/^#+\s*/u, '').trim())
    .find(line => line.length >= 5);
  if (heading) return heading.slice(0, 120);

  const basename = file.split('/').pop()?.replace(/\.md$/iu, '').replace(/[-_]+/gu, ' ') ?? '';
  const words = `${basename} ${text}`
    .replace(/[^A-Za-z0-9]+/gu, ' ')
    .split(/\s+/u)
    .filter(word => word.length >= 5)
    .slice(0, 5);
  return words.length > 0 ? words.join(' ') : null;
}

function workspaceDocsSearchCandidates(source) {
  const queries = [WORKSPACE_DOCS_QUERY];
  if (source?.localPath && existsSync(source.localPath)) {
    for (const file of walkMarkdownFiles(source.localPath)) {
      const query = queryFromMarkdownFile(file);
      if (query) queries.push(query);
    }
  }
  return [...new Set(queries.map(query => query.trim()).filter(Boolean))];
}

function searchWorkspaceDocs(gbrain, source) {
  const attempts = [];
  for (const query of workspaceDocsSearchCandidates(source)) {
    const result = run(gbrain, [
      'search',
      query,
      '--limit',
      '3',
      '--source',
      WORKSPACE_DOCS_SOURCE,
      '--json',
    ]);
    const summary = summarizeSearch(result);
    attempts.push({
      query,
      ...summary,
    });
    if (summary.ok && summary.resultCount > 0) {
      return {
        ...summary,
        query,
        attempts,
      };
    }
  }
  const last = attempts.at(-1);
  return last
    ? {
        ok: last.ok,
        resultCount: last.resultCount,
        command: last.command,
        stderr: last.stderr,
        query: last.query,
        attempts,
      }
    : {
        ok: false,
        resultCount: 0,
        command: `${gbrain} search ${WORKSPACE_DOCS_QUERY} --limit 3 --source ${WORKSPACE_DOCS_SOURCE} --json`,
        stderr: `No searchable markdown files found for ${WORKSPACE_DOCS_SOURCE}`,
        query: WORKSPACE_DOCS_QUERY,
        attempts,
      };
}

function main() {
  const gbrain = resolveBin('GBRAIN_BIN', 'gbrain');
  const openclaw = resolveBin('OPENCLAW_BIN', 'openclaw');

  const version = run(gbrain, ['version']);
  const doctor = run(gbrain, ['doctor', '--json']);
  const sourcesResult = run(gbrain, ['sources', 'list', '--json']);
  const sources = normalizeSources(parseJson(sourcesResult.stdout, []));
  const totalPages = sources.reduce((sum, source) => sum + source.pages, 0);
  const supportKb = sources.find(source => source.id === SUPPORT_KB_SOURCE) ?? null;
  const workspaceDocs = sources.find(source => source.id === WORKSPACE_DOCS_SOURCE) ?? null;
  const supportKbSearch = run(gbrain, [
    'search',
    SUPPORT_KB_QUERY,
    '--limit',
    '3',
    '--source',
    SUPPORT_KB_SOURCE,
    '--json',
  ]);
  const supportKbSearchSummary = summarizeSearch(supportKbSearch);
  const workspaceDocsSearchSummary = workspaceDocs
    ? searchWorkspaceDocs(gbrain, workspaceDocs)
    : {
        command: `${gbrain} search ${WORKSPACE_DOCS_QUERY} --limit 3 --source ${WORKSPACE_DOCS_SOURCE} --json`,
        ok: false,
        status: null,
        signal: null,
        resultCount: 0,
        query: WORKSPACE_DOCS_QUERY,
        attempts: [],
        stdout: '',
        stderr: `Source ${WORKSPACE_DOCS_SOURCE} not present`,
        timedOut: false,
      };
  const agentsDocsGuidance = checkAgentsDocsGuidance();
  const pluginInspect = run(openclaw, ['plugins', 'inspect', 'gbrain', '--runtime', '--json'], {
    timeoutMs: 15_000,
  });

  const report = {
    ok: Boolean(
      version.ok &&
      doctor.ok &&
      sourcesResult.ok &&
      (!requireSupportKb ||
        (supportKb &&
          supportKb.pages > 0 &&
          supportKbSearchSummary.ok &&
          supportKbSearchSummary.resultCount > 0)) &&
      (!requireWorkspaceDocs ||
        (workspaceDocs &&
          workspaceDocs.pages > 0 &&
          workspaceDocsSearchSummary.ok &&
          workspaceDocsSearchSummary.resultCount > 0)) &&
      (!requireAgentsDocsGuidance || agentsDocsGuidance.ok) &&
      (!requireOpenClaw || pluginInspect.ok),
    ),
    gbrain: {
      version: version.stdout.trim(),
      versionOk: version.ok,
      doctorOk: doctor.ok,
      doctor: parseJson(doctor.stdout, null),
    },
    pages: {
      total: totalPages,
      bySource: sources,
      supportKbPresent: Boolean(supportKb),
      supportKbPages: supportKb?.pages ?? 0,
      workspaceDocsPresent: Boolean(workspaceDocs),
      workspaceDocsSource: WORKSPACE_DOCS_SOURCE,
      workspaceDocsPages: workspaceDocs?.pages ?? 0,
    },
    supportKbSearch: {
      required: requireSupportKb,
      ...supportKbSearchSummary,
    },
    workspaceDocsSearch: {
      required: requireWorkspaceDocs,
      ...workspaceDocsSearchSummary,
    },
    agentsDocsGuidance,
    openclawPlugin: {
      required: requireOpenClaw,
      ok: pluginInspect.ok,
      command: pluginInspect.command,
      details: parseJson(pluginInspect.stdout, null),
      stderr: pluginInspect.ok ? '' : pluginInspect.stderr.trim(),
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

main();
