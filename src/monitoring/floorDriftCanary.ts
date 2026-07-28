/**
 * floorDriftCanary — verifies the code-pinned required-contexts floor still
 * matches reality, so a renamed workflow / split job / changed app slug surfaces
 * as `floor-drift` instead of turning the watcher into a silent permanent
 * refuser (green-pr-automerge-enforcement R8, L5(b)/P18). Observe-only.
 *
 * Per-family references (round-6 — the round-5 single-reference design was
 * structurally unsatisfiable): the pinned floor mixes PR-triggered gates (eli16,
 * decision-audit) whose runs attach to PR HEAD shas, never default-branch
 * commits, and push-triggered contexts (CI suite) that DO run on main. So:
 *   - PR-triggered floor contexts validate against the head shas of recently
 *     MERGED agent-namespace PRs (newest-qualifying-wins).
 *   - push-triggered contexts validate against the most recent default-branch
 *     commit qualified INDEPENDENTLY of the pinned set (any completed non-skip-ci
 *     runs present — qualifying ON the pinned set would let a rename hide).
 * No qualifying reference within a family's bound → `floor-drift-unverifiable`
 * (distinct from `floor-drift`: "couldn't check" never wears the "drifted" label).
 *
 * All gh I/O is injected so this is unit-testable without the network.
 */

export interface FloorPin {
  context: string;
  workflowPath: string;
  appSlug: string;
  /** Which event the producing workflow fires on. */
  trigger: 'pull_request' | 'push';
}

/** A completed check run on some commit (own + producer identity). */
export interface ReferenceCheckRun {
  name: string;
  conclusion: string;
  appSlug: string | null;
  workflowPath: string | null;
}

/** A candidate reference: a commit/head sha plus its completed check runs. */
export interface ReferenceCandidate {
  sha: string;
  checkRuns: ReferenceCheckRun[];
}

export interface FloorDriftDeps {
  /**
   * Recently MERGED agent-namespace PR heads, newest-first, bounded by
   * `floorDriftLookbackPrs`. Each carries that head's completed check runs.
   */
  recentMergedPrRefs(limit: number): Promise<ReferenceCandidate[]>;
  /**
   * Recent default-branch commits, newest-first, bounded by
   * `floorDriftLookbackCommits`, each with its completed check runs.
   */
  recentDefaultBranchRefs(limit: number): Promise<ReferenceCandidate[]>;
}

export interface FloorDriftConfig {
  floorDriftLookbackPrs: number;
  floorDriftLookbackCommits: number;
}

export type FloorDriftClass = 'ok' | 'floor-drift' | 'floor-drift-unverifiable';

export interface FloorDriftFinding {
  context: string;
  cls: FloorDriftClass;
  detail?: string;
}

export interface FloorDriftResult {
  findings: FloorDriftFinding[];
  drifted: FloorDriftFinding[];
  unverifiable: FloorDriftFinding[];
}

/** Does this candidate "qualify" as a reference for a push-triggered family? */
export function qualifiesAsPushReference(c: ReferenceCandidate): boolean {
  // Any completed (non-skip-ci) check runs present — qualified INDEPENDENTLY of
  // the pinned set, so a rename can still be observed as a mismatch.
  return c.checkRuns.some((r) => r.conclusion && r.conclusion !== 'skipped' && r.conclusion !== 'neutral');
}

/** A PR head qualifies as a PR-family reference if it carries any completed runs. */
export function qualifiesAsPrReference(c: ReferenceCandidate): boolean {
  return c.checkRuns.some((r) => !!r.conclusion);
}

/** Is the pin satisfied at this reference (name + producer binding)? */
export function pinSatisfiedAt(pin: FloorPin, ref: ReferenceCandidate): boolean {
  return ref.checkRuns.some((r) =>
    r.name === pin.context &&
    String(r.conclusion).toLowerCase() === 'success' &&
    (!pin.appSlug || r.appSlug === pin.appSlug) &&
    (!pin.workflowPath || r.workflowPath === pin.workflowPath));
}

export class FloorDriftCanary {
  constructor(
    private readonly pins: FloorPin[],
    private readonly deps: FloorDriftDeps,
    private readonly cfg: FloorDriftConfig,
  ) {}

  async check(): Promise<FloorDriftResult> {
    const prTriggered = this.pins.filter((p) => p.trigger === 'pull_request');
    const pushTriggered = this.pins.filter((p) => p.trigger === 'push');

    const prRefs = prTriggered.length > 0 ? await this.safe(() => this.deps.recentMergedPrRefs(this.cfg.floorDriftLookbackPrs)) : [];
    const pushRefs = pushTriggered.length > 0 ? await this.safe(() => this.deps.recentDefaultBranchRefs(this.cfg.floorDriftLookbackCommits)) : [];

    const findings: FloorDriftFinding[] = [];
    for (const pin of prTriggered) findings.push(this.evaluate(pin, prRefs, qualifiesAsPrReference));
    for (const pin of pushTriggered) findings.push(this.evaluate(pin, pushRefs, qualifiesAsPushReference));

    return {
      findings,
      drifted: findings.filter((f) => f.cls === 'floor-drift'),
      unverifiable: findings.filter((f) => f.cls === 'floor-drift-unverifiable'),
    };
  }

  /**
   * Newest-qualifying-wins (round-7 build note): walk references newest-first;
   * the FIRST that qualifies is authoritative. If it satisfies the pin → ok;
   * else → floor-drift. If NO reference in the bound qualifies →
   * floor-drift-unverifiable (never floor-drift).
   */
  private evaluate(pin: FloorPin, refs: ReferenceCandidate[], qualifies: (c: ReferenceCandidate) => boolean): FloorDriftFinding {
    for (const ref of refs) {
      if (!qualifies(ref)) continue;
      // First qualifying reference is authoritative (newest-wins).
      if (pinSatisfiedAt(pin, ref)) return { context: pin.context, cls: 'ok' };
      return { context: pin.context, cls: 'floor-drift', detail: `pinned ${pin.context} (${pin.appSlug} ${pin.workflowPath}) not satisfied at ${ref.sha.slice(0, 12)}` };
    }
    return { context: pin.context, cls: 'floor-drift-unverifiable', detail: `no qualifying reference within the lookback bound` };
  }

  private async safe(fn: () => Promise<ReferenceCandidate[]>): Promise<ReferenceCandidate[]> {
    try { return await fn(); } catch { /* @silent-fallback-ok: green-pr-automerge fail-safe — skip/refuse, never over-merge; safe-merge is the act-time authority */ return []; }
  }
}
