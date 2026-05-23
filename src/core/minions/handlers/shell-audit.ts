/**
 * Shell-job submission audit log (operational trace, NOT forensic insurance).
 *
 * Writes a JSONL line per shell-job submission to `~/.gbrain/audit/shell-jobs-YYYY-Www.jsonl`
 * (ISO week rotation, override via `GBRAIN_AUDIT_DIR`). Best-effort: write failures go
 * to stderr and never block submission, which means a disk-full attacker could silently
 * disable the trail. CHANGELOG calls this out honestly: it's for debugging "what did
 * this cron submit last Tuesday?", not for security-critical forensics.
 *
 * Never logs `env` values (may contain secrets). Does log `cmd` and `argv` truncated to
 * 80 chars for cmd / stored as JSON array for argv — the command text itself can contain
 * inline tokens (`curl -H 'Authorization: Bearer ...'`) and the guide explicitly tells
 * operators to put secrets in `env:` instead of embedding them in the command line.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isoWeekFilename, resolveAuditDir as _sharedResolveAuditDir } from '../../audit-week-file.ts';

export interface ShellAuditEvent {
  ts: string;
  caller: 'cli' | 'mcp';
  remote: boolean;
  job_id: number;
  cwd: string;
  cmd_display?: string;        // first 80 chars of cmd; may contain inline tokens
  argv_display?: string[];     // each arg truncated individually to preserve separation
  /** Names of inheritable secrets requested via `inherit:` (v0.35.8.0).
   *  Names only — values never appear here. */
  inherit?: string[];
}

/** Compute `shell-jobs-YYYY-Www.jsonl`. Delegates to the shared helper in
 *  `src/core/audit-week-file.ts` — Year-boundary edges (2027-01-01 → W53 of
 *  2026, 2020-W53 etc.) are covered by `test/core/audit-week-file.test.ts`. */
export function computeAuditFilename(now: Date = new Date()): string {
  return isoWeekFilename('shell-jobs', now);
}

/** Resolve the audit dir. Honors `GBRAIN_AUDIT_DIR` for container/sandbox deployments
 *  where `$HOME` is read-only. Defaults to `~/.gbrain/audit/`. Delegates to the
 *  shared helper. */
export function resolveAuditDir(): string {
  return _sharedResolveAuditDir();
}

export function logShellSubmission(event: Omit<ShellAuditEvent, 'ts'>): void {
  const dir = resolveAuditDir();
  const filename = computeAuditFilename();
  const fullPath = path.join(dir, filename);
  const line = JSON.stringify({ ...event, ts: new Date().toISOString() }) + '\n';

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fullPath, line, { encoding: 'utf8' });
  } catch (err) {
    // Best-effort: log to stderr and keep going. A disk-full or EACCES attacker
    // can silently disable this trail, which is why CHANGELOG calls it an
    // operational trace, not forensic insurance.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[shell-audit] write failed (${msg}); submission continues\n`);
  }
}
