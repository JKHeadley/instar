/**
 * RevertDetector — Ingestion-sources spec §3.2.
 *
 * Scans recent commits for `Revert "…"` and records them in the FailureLedger:
 * a revert is evidence a shipped change was bad enough to pull. Read-only git;
 * fail-open everywhere.
 *
 * Deviation note (spec §3.2 said "fold into the existing reconciler commit-scan
 * pass"): there is no clean periodic recent-commit scan to hook — the merge-
 * unreachability reconciler is per-initiative + lazy. So this is a small
 * dedicated scan on the reconciler cadence. Same outcome, isolated + testable.
 *
 * Security (spec §3.2/§4.1 — the highest-risk untrusted-input surface, since
 * commit messages on main are attacker-authorable):
 *  - A revert may **auto-CLOSE** an existing open record ONLY after a cross-check:
 *    (1) the reverted OID is a real reachable commit, AND (2) the revert's diff
 *    actually intersects the reverted commit's files. A hand-written "This
 *    reverts commit <oid>" that fails either check NEVER auto-closes — it may
 *    only OPEN an `inferred` record.
 *  - Close is matched on initiative AND causeCommitOid (not initiative alone) so
 *    a minimal real revert can't close an unrelated record for the same feature.
 *  - Revert² (a revert of a revert / re-land) is skipped — not a failure.
 *  - Close goes through update()'s mandatory ifMatch with a bounded CAS retry.
 *  - Constant filedBy 'source:revert' (analyzer session-diversity, spec §5).
 *  - Loop self-exclusion (§4.3) is inert until slice 2 adds Initiative.origin.
 */
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import type { FailureLedger } from './FailureLedger.js';

export interface RevertInitiativeRef {
  id: string;
  projectId?: string;
  specPath?: string;
  origin?: string;
}

export interface RevertDetectorOptions {
  ledger: FailureLedger;
  /** Resolve the initiative owning a commit OID (InitiativeTracker.findByMergeCommit). */
  resolveByCommit: (oid: string) => RevertInitiativeRef | undefined;
  /** Repo dir for git reads. */
  cwd: string;
  /** Injectable git runner (args → stdout). Default: SafeGitExecutor.readSync. */
  git?: (args: string[]) => string;
  isLeaseHolder?: () => boolean;
  intervalMs?: number;
  /** How many recent commits to scan per tick. Default 100. */
  scanWindow?: number;
  onError?: (err: unknown) => void;
}

const SEP_FIELD = '';
const SEP_REC = '';
const REVERTED_OID_RE = /This reverts commit ([0-9a-f]{7,40})/;

interface RevertCommit { hash: string; subject: string; revertedOid: string; }

export class RevertDetector {
  private readonly ledger: FailureLedger;
  private readonly resolveByCommit: (oid: string) => RevertInitiativeRef | undefined;
  private readonly cwd: string;
  private readonly git: (args: string[]) => string;
  private readonly isLeaseHolder: () => boolean;
  private readonly intervalMs: number;
  private readonly scanWindow: number;
  private readonly onError: (err: unknown) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: RevertDetectorOptions) {
    this.ledger = opts.ledger;
    this.resolveByCommit = opts.resolveByCommit;
    this.cwd = opts.cwd;
    this.git = opts.git ?? ((args) => SafeGitExecutor.readSync(args, { cwd: this.cwd, operation: 'failure-learning:revert-detect' }));
    this.isLeaseHolder = opts.isLeaseHolder ?? (() => true);
    this.intervalMs = opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : 6 * 60 * 60 * 1000;
    this.scanWindow = opts.scanWindow && opts.scanWindow > 0 ? opts.scanWindow : 100;
    this.onError = opts.onError ?? ((err) => console.warn('[revert-detector]', err));
  }

  start(): void {
    if (this.timer) return;
    queueMicrotask(() => this.tick());
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Parse `git log` output into revert commits with a reverted OID. Pure (testable). */
  parseReverts(logOut: string): RevertCommit[] {
    const out: RevertCommit[] = [];
    for (const rec of logOut.split(SEP_REC)) {
      const trimmed = rec.trim();
      if (!trimmed) continue;
      const [hash, subject, body] = trimmed.split(SEP_FIELD);
      if (!hash || !subject || !/^Revert\b/.test(subject)) continue;
      const m = REVERTED_OID_RE.exec(body || '');
      if (!m) continue;
      out.push({ hash: hash.trim(), subject: subject.trim(), revertedOid: m[1] });
    }
    return out;
  }

  private touchedFiles(oid: string): string[] {
    try {
      return this.git(['show', '--name-only', '--pretty=format:', oid])
        .split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { return []; }
  }

  private isReachable(oid: string): boolean {
    try { this.git(['cat-file', '-e', `${oid}^{commit}`]); return true; } catch { return false; }
  }

  private isRevertCommit(oid: string): boolean {
    try { return /^Revert\b/.test(this.git(['log', '-1', '--format=%s', oid]).trim()); } catch { return false; }
  }

  /** One scan. Public for tests. Returns # ledger writes (opens + closes). */
  tick(): number {
    if (this.running) return 0;
    this.running = true;
    let acted = 0;
    try {
      if (!this.isLeaseHolder()) return 0;
      let logOut = '';
      try {
        logOut = this.git([
          'log', `-n`, String(this.scanWindow), '--grep=^Revert', '--regexp-ignore-case=false',
          `--format=%H${SEP_FIELD}%s${SEP_FIELD}%b${SEP_REC}`,
        ]);
      } catch (err) { this.onError(err); return 0; }
      for (const rev of this.parseReverts(logOut)) {
        try {
          // Revert² / re-land is not a failure.
          if (this.isRevertCommit(rev.revertedOid)) continue;
          // Cross-check gates auto-close (§3.2): reachable + diff intersects.
          const reachable = this.isReachable(rev.revertedOid);
          const revertFiles = new Set(this.touchedFiles(rev.hash));
          const revertedFiles = this.touchedFiles(rev.revertedOid);
          const intersects = revertedFiles.some((f) => revertFiles.has(f));
          const crossCheckOk = reachable && intersects;

          const mapped = this.resolveByCommit(rev.revertedOid);
          if (mapped && mapped.origin === 'failure-learning-loop') continue; // loop self-exclusion (§4.3)

          // Decision tree (idempotent across ticks):
          // 1. Trusted revert + matching ACTIVE original record → close it.
          // 2. Trusted revert already closed an original (resolved non-revert
          //    record for this cause) → done, do NOT also open a forensic.
          // 3. A forensic 'revert' record already exists for this OID → done.
          // 4. Otherwise → open a resolved forensic record.
          const activeMatch = mapped
            ? this.ledger.list({ initiativeId: mapped.id } as never)
                .find((r) => r.causeCommitOid === rev.revertedOid && r.status !== 'resolved')
            : undefined;
          if (crossCheckOk && activeMatch) {
            if (this.closeWithRetry(activeMatch.id)) acted += 1; // (1) trusted close, CAS retry
            continue;
          }
          if (crossCheckOk && mapped && this.ledger.list({ initiativeId: mapped.id } as never)
              .some((r) => r.causeCommitOid === rev.revertedOid && r.status === 'resolved' && r.source !== 'revert')) {
            continue; // (2) already trusted-closed on a prior tick — idempotent, no forensic
          }
          if (this.ledger.list({ source: 'revert' } as never)
              .some((r) => r.causeCommitOid === rev.revertedOid)) {
            continue; // (3) forensic already recorded — idempotent
          }
          // (4) record the revert as a resolved forensic entry. Untrusted
          // (cross-check failed) → inferred; trusted+mapped → automatic.
          const attribution = crossCheckOk && mapped ? 'automatic' : 'inferred';
          const rec = this.ledger.open({
            source: 'revert', severity: 'medium', category: 'regression',
            summary: `Reverted: ${rev.subject}`,
            detail: { redacted: `revert of ${rev.revertedOid.slice(0, 12)}`, full: `${rev.hash} reverts ${rev.revertedOid}` },
            causeCommitOid: rev.revertedOid,
            initiativeId: crossCheckOk ? mapped?.id : undefined,
            projectId: crossCheckOk ? mapped?.projectId : undefined,
            specPath: crossCheckOk ? mapped?.specPath : undefined,
            filedBy: 'source:revert',
            attribution,
            attributionConfidence: attribution === 'automatic' ? 0.9 : 0.2,
          });
          // Opened revert records are forensic (status 'resolved' → excluded
          // from active clustering §6.1). open() inserts 'open'; flip to resolved.
          if (rec) { this.closeWithRetry(rec.id); acted += 1; }
        } catch (err) {
          this.onError(err); // per-commit fail-open
        }
      }
    } catch (err) {
      this.onError(err);
    } finally {
      this.running = false;
    }
    return acted;
  }

  /** Mark a record resolved with a bounded ifMatch CAS retry (update() requires ifMatch). */
  private closeWithRetry(id: string): boolean {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = this.ledger.get(id);
      if (!cur) return false;
      if (cur.status === 'resolved') return true; // already closed (idempotent)
      const res = this.ledger.update(id, { status: 'resolved' }, cur.version);
      if (res.ok) return true;
      if (!res.ok && !res.conflict) return false; // not-found / unrecoverable
      // conflict → re-read and retry
    }
    return false;
  }
}
