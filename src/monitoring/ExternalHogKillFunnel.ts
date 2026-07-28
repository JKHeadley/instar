/**
 * ExternalHogKillFunnel — the hardened kill sequence of the External-Hog sentinel
 * (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §4).
 *
 * The ONLY place a real signal is sent. Structured so the watch-only guarantee is by
 * construction: unless a LIVE kill is authorized (`canKillLive` — enabled && !dryRun && a valid
 * PIN armed marker for this class), the funnel sends NO signal and returns a `would-kill`
 * record. All I/O (fact re-read, arm re-read, fd-probe, signal send, aliveness, clock, wait) is
 * INJECTED so the sequence is fully testable without ever killing a process.
 *
 * Sequence (a candidate that has already passed §4 Stage-A CPU admission + §5 classifier=kill):
 *   1. Gate: re-read the LIVE arm state → not authorized ⇒ `would-kill` (dry-run / not-armed).
 *   2. Stage-B (pre-SIGTERM): re-read the LIVE facts → the §4 floor must still PERMIT; abort→alert.
 *   3. SIGTERM → wait `sigtermGraceMs`.
 *   4. If the process exited during grace → `sigterm-exited` (no SIGKILL needed).
 *   5. Stage-B (pre-SIGKILL): re-read facts + arm → any change/disarm ⇒ abort (never SIGKILL).
 *   6. fd-skip: an open writable WORKSPACE file ⇒ DEFER the SIGKILL (bounded by maxKillDeferrals).
 *   7. SIGKILL → `killed`.
 */

import { evaluateKillFloor, matchAllowlistClass, type ExternalHogFacts } from './ExternalHogFloor.js';
import { canKillLive, type ArmConfig, type ArmMarker } from './ExternalHogArmMarker.js';

export type KillOutcome =
  | { action: 'would-kill'; reason: 'dry-run' | 'not-armed' }
  | { action: 'killed' }
  | { action: 'sigterm-exited' }
  | { action: 'deferred'; reason: 'writable-workspace-file' }
  | { action: 'aborted'; reason: string };

export interface KillTarget {
  readonly pid: number;
  readonly startTime: string;
  readonly commandHash: string;
  readonly classId: string;
}

export interface KillArmState {
  readonly config: ArmConfig;
  readonly marker: ArmMarker | null;
  readonly lastDisarmEpoch: number;
}

export interface KillFunnelDeps {
  /** Re-read the LIVE deterministic facts for (pid, startTime); null if gone/identity-changed.
   *  May be async (a fresh ps + argv read) — the funnel awaits it. */
  reReadFacts(pid: number, startTime: string): ExternalHogFacts | null | Promise<ExternalHogFacts | null>;
  /** Re-read the LIVE arm state (config + marker + lastDisarmEpoch). */
  reReadArmState(): KillArmState;
  /** The current content-hash of a class's compiled match rules (for the arm-scope check). */
  currentClassContentHash(classId: string): string;
  /** True if the pid holds an open writable REGULAR file under a workspace/document path.
   *  May be async (an lsof-shaped probe) — the funnel awaits it. */
  hasOpenWritableWorkspaceFile(pid: number): boolean | Promise<boolean>;
  /** Send a signal ('SIGTERM' | 'SIGKILL') to the pid. */
  sendSignal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Is (pid, startTime) still the live, same process? */
  stillAlive(pid: number, startTime: string): boolean;
  /** Await ms (injected so tests control the grace wait). */
  wait(ms: number): Promise<void>;
}

export interface KillFunnelOpts {
  readonly sigtermGraceMs: number;
  readonly maxKillDeferrals: number;
  /** How many times THIS target has already been deferred (caller-tracked). */
  readonly currentDeferrals: number;
}

/** Re-check the full authorization + floor for a target, live. Returns null if OK to proceed,
 *  or a `would-kill`/`aborted` outcome to short-circuit. */
async function reCheck(target: KillTarget, deps: KillFunnelDeps): Promise<KillOutcome | null> {
  const arm = deps.reReadArmState();
  if (!canKillLive(arm.config, arm.marker, arm.lastDisarmEpoch, target.classId, deps.currentClassContentHash(target.classId))) {
    return { action: 'would-kill', reason: arm.config && arm.config.dryRun !== false ? 'dry-run' : 'not-armed' };
  }
  const facts = await deps.reReadFacts(target.pid, target.startTime);
  if (!facts) return { action: 'aborted', reason: 'identity-changed-or-gone' };
  // Re-verify the target is still in the allowlist class it was matched under (belt + suspenders).
  if (matchAllowlistClass(facts.name, facts.argv) !== target.classId) {
    return { action: 'aborted', reason: 'class-changed' };
  }
  const floor = evaluateKillFloor(facts);
  if (!floor.permitted) return { action: 'aborted', reason: `floor-veto:${floor.vetoReason}` };
  return null;
}

/**
 * Run the kill funnel for one target. Sends real signals ONLY when a live kill is authorized at
 * BOTH re-check points; otherwise returns a non-destructive outcome. Pure control flow over the
 * injected I/O.
 */
export async function runKillFunnel(target: KillTarget, opts: KillFunnelOpts, deps: KillFunnelDeps): Promise<KillOutcome> {
  // (1)+(2) Pre-SIGTERM gate + Stage-B floor re-check.
  const pre = await reCheck(target, deps);
  if (pre) return pre; // would-kill (watch-only/unarmed) or aborted — NO signal sent.

  // (3) SIGTERM → grace.
  deps.sendSignal(target.pid, 'SIGTERM');
  await deps.wait(Math.max(0, opts.sigtermGraceMs));

  // (4) Exited gracefully during grace? Done.
  if (!deps.stillAlive(target.pid, target.startTime)) return { action: 'sigterm-exited' };

  // (5) Pre-SIGKILL re-check: a disarm / identity change / floor veto in the grace window aborts
  //     the escalation (the SIGTERM already sent is a graceful ask; we do NOT force-kill).
  const post = await reCheck(target, deps);
  if (post) {
    // If it de-authorized (would-kill) or a fact changed (aborted) mid-grace, do NOT SIGKILL.
    return post.action === 'would-kill' ? { action: 'aborted', reason: `disarmed-mid-grace:${post.reason}` } : post;
  }

  // (6) fd-skip: an in-progress workspace write DEFERS the SIGKILL (bounded).
  if ((await deps.hasOpenWritableWorkspaceFile(target.pid)) && opts.currentDeferrals < opts.maxKillDeferrals) {
    return { action: 'deferred', reason: 'writable-workspace-file' };
  }

  // (7) SIGKILL.
  deps.sendSignal(target.pid, 'SIGKILL');
  return { action: 'killed' };
}
