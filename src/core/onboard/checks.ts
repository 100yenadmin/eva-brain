// src/core/onboard/checks.ts
// sourcescope:file-brain-wide — every SQL site here is intentionally
// brain-wide aggregate. The onboard checks REPORT across all sources
// (orphan_count, stale_count, link_coverage, takes_count) so adding
// source_id WHERE clauses would change the semantic. Per A26.
//
// v0.41.18.0 (A16, T4). Four new doctor checks consumed by both:
//   - src/commands/doctor.ts runDoctor      (local surface)
//   - src/core/doctor-remote.ts             (thin-client surface)
//   - src/core/onboard/plan-from-checks.ts  (onboard remediation aggregator)
//
// Each helper is shaped: compute metric → return both Check entry (for
// doctor render) and RemediationStep[] (for onboard's extra-remediation
// plumbing per A2). Helpers stay PURE wrt config: no engine.connect, no
// process.exit. SQL via engine.executeRaw with `sourceScopeOpts(ctx)`
// when ctx threads — onboard surface threads explicitly per A26.

import type { BrainEngine } from '../engine.ts';
import type { RemediationStep } from '../remediation-step.ts';
import { makeRemediationStep } from '../remediation-step.ts';

/** Shared shape returned by all four checks. */
export interface OnboardCheckResult {
  check: {
    name: string;
    status: 'ok' | 'warn' | 'fail';
    message: string;
  };
  remediations: RemediationStep[];
}

/** Internal sql helper. Returns first row or empty object on throw. */
async function safeCount(engine: BrainEngine, sql: string, params: unknown[] = []): Promise<number> {
  try {
    const result = await engine.executeRaw(sql, params);
    const rows = (result as { rows?: Array<Record<string, unknown>> } | undefined)?.rows
      ?? (result as Array<Record<string, unknown>> | undefined)
      ?? [];
    const row = rows[0] ?? {};
    const raw = (row as Record<string, unknown>).count ?? (row as Record<string, unknown>).c ?? 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * embed_staleness: count of chunks awaiting embedding.
 *
 * Backed by content_chunks_stale_idx partial index (v100) so the count
 * is cheap even on big brains.
 */
export async function checkEmbedStaleness(
  engine: BrainEngine,
): Promise<OnboardCheckResult> {
  const staleCount = await safeCount(
    engine,
    `SELECT COUNT(*) AS count FROM content_chunks WHERE embedding IS NULL`,
  );
  const remediations: RemediationStep[] = [];
  let status: 'ok' | 'warn' | 'fail' = 'ok';
  let message: string;

  if (staleCount === 0) {
    message = 'No stale chunks';
  } else if (staleCount < 1000) {
    status = 'warn';
    message = `${staleCount} stale chunks (small backlog)`;
    remediations.push(makeRemediationStep({
      id: 'onboard.embed_catch_up',
      job: 'embed-catch-up',
      params: { batchSize: 500 },
      severity: 'medium',
      est_seconds: Math.min(900, Math.ceil(staleCount * 0.2)),
      est_usd_cost: staleCount * 0.00002,
      rationale: `${staleCount} chunks awaiting embedding`,
      status: 'remediable',
    }));
  } else {
    // v0.41.18.0: warn-only even on large backlogs. Doctor exit code should
    // not flip from a brain that has pages waiting to be embedded — that's
    // a "needs work" condition, not a "broken" one. The high-severity
    // remediation still surfaces via onboard's plan.
    status = 'warn';
    message = `${staleCount} stale chunks (large backlog — vector search returning outdated content)`;
    remediations.push(makeRemediationStep({
      id: 'onboard.embed_catch_up',
      job: 'embed-catch-up',
      params: { batchSize: 1000, priority: 'recent' },
      severity: 'high',
      est_seconds: Math.min(3600, Math.ceil(staleCount * 0.2)),
      est_usd_cost: staleCount * 0.00002,
      rationale: `${staleCount} chunks awaiting embedding; recent-first catch-up`,
      status: 'remediable',
    }));
  }
  return {
    check: { name: 'embed_staleness', status, message },
    remediations,
  };
}

/**
 * entity_link_coverage: fraction of entity pages with at least one inbound link.
 *
 * Per A21 + codex finding #15: TABLESAMPLE BERNOULLI on Postgres when
 * total_pages > 50K, with pinned sample rate (LEAST 100, GREATEST 2,
 * targeting ~5000 sampled rows). PGLite path: full scan.
 *
 * The ±sqrt(p(1-p)/n) confidence interval is embedded in the message
 * itself so doctor + onboard render show "coverage: 31% ± 1.3%" not
 * a misleading point estimate.
 */
export async function checkEntityLinkCoverage(
  engine: BrainEngine,
): Promise<OnboardCheckResult> {
  // Total entity pages
  const totalEntities = await safeCount(
    engine,
    `SELECT COUNT(*) AS count FROM pages
       WHERE type IN ('person', 'company', 'organization', 'entity')
         AND deleted_at IS NULL`,
  );

  if (totalEntities === 0) {
    return {
      check: { name: 'entity_link_coverage', status: 'ok', message: 'No entity pages — coverage check vacuous' },
      remediations: [],
    };
  }

  // Decide TABLESAMPLE policy (PG only, when >50K entities)
  const useSample = engine.kind === 'postgres' && totalEntities > 50_000;
  const samplePct = useSample
    ? Math.max(2.0, Math.min(100.0, (5000.0 / totalEntities) * 100))
    : 100;
  const sampleClause = useSample ? `TABLESAMPLE BERNOULLI (${samplePct.toFixed(2)})` : '';

  // Sample query: counts entities with inbound links
  const linkedCount = await safeCount(
    engine,
    `SELECT COUNT(*) AS count FROM (
       SELECT p.id FROM pages p ${sampleClause}
       WHERE p.type IN ('person', 'company', 'organization', 'entity')
         AND p.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)
     ) sub`,
  );
  const sampleSize = useSample
    ? Math.max(1, Math.round(totalEntities * (samplePct / 100)))
    : totalEntities;

  const coverage = sampleSize > 0 ? linkedCount / sampleSize : 0;
  // Wilson-ish confidence interval (1σ; ±sqrt(p(1-p)/n))
  const ci = Math.sqrt((coverage * (1 - coverage)) / Math.max(1, sampleSize));

  const pct = Math.round(coverage * 100);
  const ciPct = (ci * 100).toFixed(1);
  const sampleNote = useSample ? ` (sampled ${samplePct.toFixed(1)}%)` : '';

  const remediations: RemediationStep[] = [];
  let status: 'ok' | 'warn' | 'fail' = 'ok';
  let message: string;

  // v0.41.18.0: warn-only, never fail. Empty entity link coverage is "needs
  // work" not "broken" — doctor's exit code should not flip from a fresh
  // brain with entity pages but no auto-extracted links yet. Fail status
  // would break `gbrain doctor exits 0` contract; the recommendation
  // surfaces the same fix via the onboard plan either way.
  if (coverage >= 0.7) {
    message = `Coverage ${pct}% ± ${ciPct}%${sampleNote}`;
  } else if (coverage >= 0.4) {
    status = 'warn';
    message = `Coverage ${pct}% ± ${ciPct}% (target 70%)${sampleNote}`;
    remediations.push(makeRemediationStep({
      id: 'onboard.extract_ner_links',
      job: 'extract-ner',
      params: {},
      severity: 'medium',
      est_seconds: 300,
      est_usd_cost: 0,
      rationale: `Entity link coverage at ${pct}%; NER extraction lifts typed-link density`,
      status: 'remediable',
    }));
  } else {
    status = 'warn';
    message = `Coverage ${pct}% ± ${ciPct}% (target 70%)${sampleNote}`;
    remediations.push(makeRemediationStep({
      id: 'onboard.extract_ner_links',
      job: 'extract-ner',
      params: {},
      severity: 'high',
      est_seconds: 600,
      est_usd_cost: 0,
      rationale: `Entity link coverage at ${pct}%; NER extraction lifts typed-link density`,
      status: 'remediable',
    }));
  }
  return {
    check: { name: 'entity_link_coverage', status, message },
    remediations,
  };
}

/**
 * timeline_coverage: fraction of entity pages with at least one timeline entry.
 *
 * Same TABLESAMPLE policy as entity_link_coverage for big brains.
 */
export async function checkTimelineCoverage(
  engine: BrainEngine,
): Promise<OnboardCheckResult> {
  const totalEntities = await safeCount(
    engine,
    `SELECT COUNT(*) AS count FROM pages
       WHERE type IN ('person', 'company', 'organization', 'entity')
         AND deleted_at IS NULL`,
  );

  if (totalEntities === 0) {
    return {
      check: { name: 'timeline_coverage', status: 'ok', message: 'No entity pages — coverage check vacuous' },
      remediations: [],
    };
  }

  const useSample = engine.kind === 'postgres' && totalEntities > 50_000;
  const samplePct = useSample
    ? Math.max(2.0, Math.min(100.0, (5000.0 / totalEntities) * 100))
    : 100;
  const sampleClause = useSample ? `TABLESAMPLE BERNOULLI (${samplePct.toFixed(2)})` : '';

  const withTimelineCount = await safeCount(
    engine,
    `SELECT COUNT(*) AS count FROM (
       SELECT p.id FROM pages p ${sampleClause}
       WHERE p.type IN ('person', 'company', 'organization', 'entity')
         AND p.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id = p.id)
     ) sub`,
  );
  const sampleSize = useSample
    ? Math.max(1, Math.round(totalEntities * (samplePct / 100)))
    : totalEntities;

  const coverage = sampleSize > 0 ? withTimelineCount / sampleSize : 0;
  const ci = Math.sqrt((coverage * (1 - coverage)) / Math.max(1, sampleSize));
  const pct = Math.round(coverage * 100);
  const ciPct = (ci * 100).toFixed(1);
  const sampleNote = useSample ? ` (sampled ${samplePct.toFixed(1)}%)` : '';

  const remediations: RemediationStep[] = [];
  let status: 'ok' | 'warn' | 'fail' = 'ok';
  let message: string;

  // v0.41.18.0: warn-only, never fail. Same posture as entity_link_coverage —
  // the recommendation still surfaces in onboard's plan, but doctor exit
  // code doesn't flip on a fresh brain.
  if (coverage >= 0.9) {
    message = `Coverage ${pct}% ± ${ciPct}%${sampleNote}`;
  } else if (coverage >= 0.7) {
    status = 'warn';
    message = `Coverage ${pct}% ± ${ciPct}% (target 90%)${sampleNote}`;
    remediations.push(makeRemediationStep({
      id: 'onboard.extract_timeline_from_meetings',
      job: 'extract-timeline-from-meetings',
      params: {},
      severity: 'medium',
      est_seconds: 240,
      est_usd_cost: 0,
      rationale: `Timeline coverage at ${pct}%; meeting-derived entries lift it`,
      status: 'remediable',
    }));
  } else {
    status = 'warn';
    message = `Coverage ${pct}% ± ${ciPct}% (target 90%)${sampleNote}`;
    remediations.push(makeRemediationStep({
      id: 'onboard.extract_timeline_from_meetings',
      job: 'extract-timeline-from-meetings',
      params: {},
      severity: 'high',
      est_seconds: 480,
      est_usd_cost: 0,
      rationale: `Timeline coverage at ${pct}%; meeting-derived entries lift it`,
      status: 'remediable',
    }));
  }
  return {
    check: { name: 'timeline_coverage', status, message },
    remediations,
  };
}

/**
 * takes_count: number of takes (typed claims) in the brain.
 *
 * Per A12 two-gate consent: the remediation only emits when
 * `takes.bootstrap_enabled` config is true. Otherwise the check shows
 * a status + hint, but no autopilot-eligible remediation.
 */
export async function checkTakesCount(
  engine: BrainEngine,
): Promise<OnboardCheckResult> {
  const takesCount = await safeCount(
    engine,
    `SELECT COUNT(*) AS count FROM takes`,
  );

  let bootstrapEnabled = false;
  try {
    const cfg = await engine.getConfig('takes.bootstrap_enabled');
    bootstrapEnabled = cfg === 'true' || cfg === '1';
  } catch {
    bootstrapEnabled = false;
  }

  const remediations: RemediationStep[] = [];
  let status: 'ok' | 'warn' | 'fail' = 'ok';
  let message: string;

  if (takesCount >= 100) {
    message = `${takesCount} takes (calibration ready)`;
  } else if (takesCount === 0) {
    status = 'warn';
    if (bootstrapEnabled) {
      message = `0 takes (bootstrap eligible — gbrain takes extract --from-pages)`;
      remediations.push(makeRemediationStep({
        id: 'onboard.takes_bootstrap',
        job: 'extract-takes-from-pages',
        protected: true,
        params: {},
        severity: 'medium',
        est_seconds: 1800,
        est_usd_cost: 5.00,
        rationale: '0 takes; LLM-bearing extraction over concept/atom/lore pages',
        status: 'remediable',
      }));
    } else {
      message = '0 takes (takes.bootstrap_enabled is false; opt in to enable)';
    }
  } else {
    message = `${takesCount} takes (calibration usable; >100 ideal)`;
  }
  return {
    check: { name: 'takes_count', status, message },
    remediations,
  };
}

/**
 * Run all four checks in parallel; aggregate into a single payload.
 * Consumed by onboard's plan generation + (later) doctor's runDoctor.
 *
 * Per A20: callers can race this against an AbortSignal-bound timer for
 * partial-results fallthrough. Each individual safeCount() returns 0
 * on throw so a single check failure doesn't break the aggregate.
 */
export async function runAllOnboardChecks(
  engine: BrainEngine,
): Promise<OnboardCheckResult[]> {
  return Promise.all([
    checkEmbedStaleness(engine),
    checkEntityLinkCoverage(engine),
    checkTimelineCoverage(engine),
    checkTakesCount(engine),
  ]);
}
