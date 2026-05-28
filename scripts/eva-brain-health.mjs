#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SUPPORT_KB_SOURCE = 'openclaw-support-kb';
const SUPPORT_KB_QUERY = 'OpenClaw';
const WORKSPACE_DOCS_SOURCE = process.env.EVA_BRAIN_WORKSPACE_DOCS_SOURCE || 'workspace-docs';
const WORKSPACE_DOCS_QUERY = process.env.EVA_BRAIN_WORKSPACE_DOCS_QUERY || 'runbooks';
const DEFAULT_TIMEOUT_MS = 30_000;

const requireOpenClaw = process.argv.includes('--require-openclaw') || process.env.EVA_BRAIN_REQUIRE_OPENCLAW === 'true';
const allowMissingSupportKb = process.argv.includes('--allow-missing-support-kb') || process.env.EVA_BRAIN_ALLOW_MISSING_SUPPORT_KB === 'true';
const requireSupportKb = process.argv.includes('--require-support-kb') || !allowMissingSupportKb;
const requireWorkspaceDocs = process.argv.includes('--require-workspace-docs') || process.env.EVA_BRAIN_REQUIRE_WORKSPACE_DOCS === 'true';

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

function normalizeSources(value) {
  const rawSources = Array.isArray(value) ? value : Array.isArray(value?.sources) ? value.sources : [];
  return rawSources.map(source => {
    const id = String(source.id ?? source.source_id ?? source.sourceId ?? source.name ?? 'unknown');
    const pages = Number(source.page_count ?? source.pageCount ?? source.pages ?? 0);
    const chunks = Number(source.chunk_count ?? source.chunkCount ?? source.chunks ?? 0);
    return {
      id,
      pages: Number.isFinite(pages) ? pages : 0,
      chunks: Number.isFinite(chunks) ? chunks : 0,
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
  const workspaceDocsSearch = workspaceDocs
    ? run(gbrain, [
        'search',
        WORKSPACE_DOCS_QUERY,
        '--limit',
        '3',
        '--source',
        WORKSPACE_DOCS_SOURCE,
        '--json',
      ])
    : {
        command: `${gbrain} search ${WORKSPACE_DOCS_QUERY} --limit 3 --source ${WORKSPACE_DOCS_SOURCE} --json`,
        ok: false,
        status: null,
        signal: null,
        stdout: '',
        stderr: `Source ${WORKSPACE_DOCS_SOURCE} not present`,
        timedOut: false,
      };
  const workspaceDocsSearchSummary = summarizeSearch(workspaceDocsSearch);
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
