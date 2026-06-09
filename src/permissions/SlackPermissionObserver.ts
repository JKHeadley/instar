/**
 * SlackPermissionObserver — the single object the SlackAdapter calls to evaluate a
 * message against the permission gate. Composes resolver → gate → ledger.
 *
 * Slice 0 ships OBSERVE-ONLY: `observe()` evaluates and RECORDS the verdict but
 * never blocks the message path (enforce=false). This lets us measure the gate's
 * decisions (and false-positive rate) against real traffic before enforcement is
 * ever switched on (§11). It must NEVER throw — a failure here cannot break delivery.
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.6, §6.10, §11.
 *
 * RULE 3: EXEMPT — the "Observer" here is a permission-gate orchestrator
 * (resolver → gate → ledger + baseline feed), NOT a provider/external-state
 * detector. It parses no process output, tails no logs, and reads no
 * tmux/CLI state — so the state-detection-robustness rule (provider portability)
 * does not apply. Its only inputs are an already-parsed Slack message envelope
 * and the deterministic permission gate.
 */

import type { PermissionVerdict } from './types.js';
import type { SlackPrincipalResolver } from './SlackPrincipalResolver.js';
import type { SlackPermissionGate } from './SlackPermissionGate.js';
import type { PermissionDecisionLedger } from './PermissionDecisionLedger.js';
import type { RelationshipBehaviorStore } from './RelationshipBehaviorStore.js';

export interface ObserveInput {
  slackUserId: string;
  displayName?: string;
  text: string;
  directed: boolean;
  channel?: string;
}

export interface SlackPermissionObserverDeps {
  resolver: SlackPrincipalResolver;
  gate: SlackPermissionGate;
  ledger: PermissionDecisionLedger;
  /** When true the observer would ENFORCE (block). Slice 0 ships observe-only (false). */
  enforce?: boolean;
  /**
   * Optional behavioral baseline store (Pillar 3). When present, every observed
   * request's SHAPE (action/tier/hour/length/urgency — never content) is recorded
   * so the RelationshipAnomalyScorer's baseline grows from real traffic. Off by
   * default (Pillar 3 ships dark). Recording is best-effort and never blocks.
   */
  behaviorStore?: RelationshipBehaviorStore;
  /** Now() for the recorded hour-of-day (injectable for tests). */
  now?: () => Date;
}

const URGENCY_RE =
  /\b(urgent|urgently|asap|right now|immediately|before eod|by eod|end of day|emergency|hurry|quickly|can'?t wait)\b/i;

export class SlackPermissionObserver {
  constructor(private readonly deps: SlackPermissionObserverDeps) {}

  /** Resolve → evaluate → record (observe-only). Returns the verdict; never throws. */
  async observe(input: ObserveInput): Promise<PermissionVerdict | null> {
    try {
      const principal = this.deps.resolver.resolve(input.slackUserId, input.displayName);
      const verdict = await this.deps.gate.evaluate({
        principal,
        text: input.text,
        directed: input.directed,
        channel: input.channel,
      });
      this.deps.ledger.record(verdict, { channel: input.channel, enforced: this.enforcing });
      this.recordBehavior(input, verdict);
      return verdict;
    } catch {
      // Observe-only: a gate/ledger failure must NEVER break the message path.
      return null;
    }
  }

  /**
   * Feed the behavioral baseline (Pillar 3) with the request's SHAPE — never content.
   * Best-effort: a failure here cannot break the message path. Only records DIRECTED
   * requests from a verified slackUserId (overheard chatter is not "this person's
   * normal behavior"), so the baseline reflects real interactions, not channel noise.
   */
  private recordBehavior(input: ObserveInput, verdict: PermissionVerdict): void {
    const store = this.deps.behaviorStore;
    if (!store) return;
    try {
      if (!input.slackUserId || !verdict.intent.directed) return;
      const now = (this.deps.now ?? (() => new Date()))();
      store.record(input.slackUserId, {
        action: verdict.intent.action,
        tier: verdict.intent.tier,
        hour: now.getHours(),
        length: (input.text || '').length,
        urgent: URGENCY_RE.test(input.text || ''),
      });
    } catch {
      // Baseline recording must NEVER break the message path.
    }
  }

  get enforcing(): boolean {
    return this.deps.enforce ?? false;
  }
}
