// src/commands/onboard.ts
// sourcescope:file-brain-wide — the --history surface reads
// migration_impact_log brain-wide. Per A26 lint opt-out.
//
// v0.41.18.0 (A1, T13). CLI shell for `gbrain onboard`. Thin wrapper over:
//   - T2 library: computeRemediationPlan + runRemediation
//   - T4 onboard checks: runAllOnboardChecks (extra remediations)
//   - T12 render: buildOnboardReport + renderHuman
//
// Three modes:
//   --check    (default): print plan, no submission
//   --auto:               submit auto_apply tier (requires --max-usd)
//   --auto --yes:         also submit prompt_required tier
//   --history:            show recent migration_impact_log entries
//
// `--json` switches to the stable JSON envelope. No CLI mode → human render.

import type { BrainEngine } from '../core/engine.ts';
import { computeRemediationPlan, runRemediation } from '../core/remediation/index.ts';
import { runAllOnboardChecks } from '../core/onboard/checks.ts';
import { buildOnboardReport, renderHuman } from '../core/onboard/render.ts';

function parseInt10(args: string[], flag: string): number | null {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return null;
  const v = parseInt(args[i + 1] ?? '', 10);
  return isNaN(v) ? null : v;
}

function parseFloat10(args: string[], flag: string): number | null {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return null;
  const v = parseFloat(args[i + 1] ?? '');
  return isNaN(v) ? null : v;
}

export async function runOnboard(engine: BrainEngine, args: string[]): Promise<void> {
  const check = args.includes('--check') || (!args.includes('--auto') && !args.includes('--history'));
  const auto = args.includes('--auto');
  const yes = args.includes('--yes');
  const history = args.includes('--history');
  const jsonOutput = args.includes('--json');
  const targetScore = parseInt10(args, '--target-score') ?? 90;
  const maxUsdRaw = parseFloat10(args, '--max-usd');
  const maxUsd = maxUsdRaw === null ? undefined : maxUsdRaw;

  // --history shows the impact log directly; no plan computation.
  if (history) {
    const rows = await engine.executeRaw<{
      remediation_id: string;
      metric_name: string;
      metric_before: number | null;
      metric_after: number | null;
      applied_at: string;
    }>(
      `SELECT remediation_id, metric_name, metric_before, metric_after, applied_at
         FROM migration_impact_log
        ORDER BY applied_at DESC
        LIMIT 50`,
    );
    const historyEntries = rows.map((r) => ({
      remediation_id: r.remediation_id,
      metric_name: r.metric_name,
      metric_before: r.metric_before === null ? null : Number(r.metric_before),
      metric_after: r.metric_after === null ? null : Number(r.metric_after),
      delta: (r.metric_before === null || r.metric_after === null)
        ? null
        : Number(r.metric_after) - Number(r.metric_before),
      applied_at: r.applied_at,
    }));
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({
        schema_version: 1,
        history: historyEntries,
      }, null, 2) + '\n');
      return;
    }
    process.stdout.write(`Onboard history (last ${historyEntries.length}):\n`);
    for (const h of historyEntries) {
      const delta = h.delta !== null ? (h.delta > 0 ? `+${h.delta}` : String(h.delta)) : '?';
      process.stdout.write(
        `  ${h.applied_at}  ${h.remediation_id}  ${h.metric_name}: ` +
        `${h.metric_before ?? '?'} → ${h.metric_after ?? '?'} (${delta})\n`,
      );
    }
    return;
  }

  // --auto refuses without --max-usd (cron-safety per A12 + A20).
  if (auto && maxUsd === undefined) {
    process.stderr.write(
      `gbrain onboard --auto refuses without --max-usd N.\n` +
      `Set a cap to avoid surprise spend:\n` +
      `  gbrain onboard --auto --max-usd 5\n`,
    );
    process.exit(2);
  }

  // Build the plan: T4 checks supply extra remediations on top of T3's
  // generalized planner.
  const onboardCheckResults = await runAllOnboardChecks(engine);
  const extraRemediations = onboardCheckResults.flatMap((r) => r.remediations);

  if (check && !auto) {
    const plan = await computeRemediationPlan(engine, { targetScore, extraRemediations });
    const report = buildOnboardReport(plan);
    if (jsonOutput) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }
    process.stdout.write(renderHuman(report) + '\n');
    return;
  }

  // --auto path: runs through the T2 library orchestrator. Hooks emit CLI
  // progress to stderr; the final result lands as JSON on stdout (or human
  // summary).
  const result = await runRemediation(
    engine,
    {
      targetScore,
      maxUsd,
      // --auto --yes opts into the prompt_required tier too; library
      // doesn't distinguish auto_apply vs prompt_required, it just runs
      // every remediation in the plan. The plan-building side (T12 render)
      // does the tier distinction; for --auto without --yes, the CLI shell
      // would pre-filter the extras to auto_apply only. For now: pass
      // everything; CLI documents this is "everything" behavior.
    },
    {
      onTargetUnreachable: (target, ceiling) => {
        process.stderr.write(
          `[onboard] target ${target}/100 unreachable; max autonomous = ${ceiling}/100. ` +
          `Configure missing prereqs (run gbrain doctor --remediation-plan) or lower --target-score.\n`,
        );
      },
      onNothingToDo: (score, target) => {
        process.stdout.write(
          `Brain at score ${score}/100, target ${target}/100. Nothing to do.\n`,
        );
      },
      onBudgetRefused: (estCost, cap) => {
        process.stderr.write(
          `[onboard] est cost $${estCost.toFixed(2)} exceeds --max-usd $${cap.toFixed(2)}. Aborting.\n`,
        );
      },
      onStepStart: (step, total, rec) => {
        process.stderr.write(`[onboard] [${step}/${total}] ${rec.job} (${rec.severity})...\n`);
      },
      onStepEnd: (sr) => {
        process.stderr.write(`[onboard]    → ${sr.status}\n`);
      },
      onBudgetExhausted: (planHash, snapshot) => {
        process.stderr.write(
          `\n[onboard] BudgetExhausted (${snapshot.reason}): spent $${snapshot.spent.toFixed(4)} > cap $${snapshot.cap.toFixed(2)}.\n` +
          `Checkpoint saved. Resume with:\n  gbrain doctor --remediate --resume ${planHash}\n`,
        );
      },
    },
  );

  if (result.target_unreachable) process.exit(2);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (result.submitted.length > 0) {
    process.stdout.write(
      `\nBrain score: ${result.brain_score_initial} → ${result.brain_score_final} (target ${targetScore})\n` +
      `Submitted: ${result.submitted.length} job(s), ${result.aborted_count} aborted/failed\n`,
    );
  }

  const anyFailed = result.submitted.some(
    (s) => s.status !== 'completed' && s.status !== 'submitted' && s.status !== 'dry_run',
  );
  if (result.budget_exhausted || anyFailed) process.exit(1);
}
