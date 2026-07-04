/**
 * ExternalHogScanTick — the orchestrator that composes the External-Hog sentinel's modules into
 * ONE scan tick (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §1-§6).
 *
 * This is the "make it alive" integration: discovery (sampler) → classify (worst-CPU-first under
 * the cap) → floor → kill funnel → P19 ledger → P17 coalesced notices. All I/O is INJECTED
 * (read ps, build ownership, classify, the kill-funnel deps, clock, deliver) so the whole tick
 * is end-to-end testable without a real ps read, a real model call, or a real signal. The thin
 * server-side wiring (the actual ps spawn, LlmQueue call, notice delivery, interval) is a
 * separate slice; this is the pure control flow that ties the reviewed modules together.
 *
 * Watch-only rides through: the kill funnel returns `would-kill` (no signal) unless a live kill
 * is authorized, so in the shipped dryRun state a scan tick produces would-kill records + the
 * §4 observability notices, and kills NOTHING.
 */

import type { ProcTableRow } from './ExternalHogProcTable.js';
import { advanceSampler, type SamplerState, type SamplerOpts, type Candidate } from './ExternalHogSampler.js';
import type { ProcTree, OwnedRefs } from './ExternalHogOwnership.js';
import { selectForClassification, parseClassifierVerdict, type ClassifierVerdict } from './ExternalHogClassifier.js';
import { evaluateKillFloor, matchAllowlistClass, type ExternalHogFacts } from './ExternalHogFloor.js';
import { runKillFunnel, type KillOutcome, type KillTarget, type KillFunnelDeps, type KillFunnelOpts } from './ExternalHogKillFunnel.js';
import {
  isBreakerTripped, recordKill, type KillLedgerState, type BreakerOpts,
} from './ExternalHogKillLedger.js';
import { coalesceNotices, type Notice, type CoalesceResult } from './ExternalHogNoticeCoalescer.js';

export interface ScanState {
  readonly sampler: SamplerState;
  readonly ledger: KillLedgerState;
}

export interface ScanDeps {
  /** The current parsed ps table (the sampler's input). */
  readProcTable(): readonly ProcTableRow[];
  /** Build the ownership sets (tree + owned pids) from the current table + instar pids. */
  buildOwnership(table: readonly ProcTableRow[]): { tree: ProcTree; owned: OwnedRefs };
  /** Full deterministic facts for a candidate (the floor input); null if it vanished. */
  factsFor(candidate: Candidate): ExternalHogFacts | null;
  /** The command-hash + ledger key + class for a candidate (identity for the ledger/funnel). */
  identityFor(candidate: Candidate, facts: ExternalHogFacts): { commandHash: string; ledgerKey: string; classId: string } | null;
  /** Call the classifier (LlmQueue). Returns raw model output, or null if the decider is unavailable. */
  classify(facts: ExternalHogFacts): Promise<unknown>;
  /** The kill-funnel I/O (re-read facts/arm, fd-probe, signal, aliveness, wait). */
  killFunnelDeps: KillFunnelDeps;
  /** A monotonic clock reading (ms). */
  nowMs(): number;
  /** How many times a target signature has already been deferred (for maxKillDeferrals). */
  deferralsFor(ledgerKey: string): number;
}

export interface ScanOpts {
  readonly sampler: SamplerOpts;
  readonly maxClassificationsPerScan: number;
  readonly breaker: Omit<BreakerOpts, 'nowMs'>;
  readonly killFunnel: Omit<KillFunnelOpts, 'currentDeferrals'>;
  readonly noticeBudgetPerWindow: number;
  readonly killLedgerRetentionMs: number;
}

export interface ScanResult {
  readonly nextState: ScanState;
  /** Per-candidate outcomes (for the audit/soak log). */
  readonly outcomes: ReadonlyArray<{ pid: number; verdict: ClassifierVerdict | 'decider-unavailable'; outcome: KillOutcome | 'alert-only' }>;
  /** The coalesced notices to deliver. */
  readonly notices: CoalesceResult;
}

/**
 * Run one scan tick. Pure control flow over the injected I/O; mutates nothing. In the shipped
 * dryRun state every `outcome` is `would-kill`/`alert-only` and no signal is sent.
 */
export async function runScanTick(state: ScanState, deps: ScanDeps, opts: ScanOpts): Promise<ScanResult> {
  const now = deps.nowMs();
  const table = deps.readProcTable();
  const { tree, owned } = deps.buildOwnership(table);

  // Stage-1 candidacy.
  const tick = advanceSampler(state.sampler, table, tree, owned, now, opts.sampler);
  const nextSampler = tick.nextState;

  // Worst-CPU-first under the per-scan classifier cap.
  const outcomes: Array<{ pid: number; verdict: ClassifierVerdict | 'decider-unavailable'; outcome: KillOutcome | 'alert-only' }> = [];
  const notices: Notice[] = [];
  let ledger = state.ledger;

  // Enrich candidates. A candidate whose facts VANISHED (factsFor null) is skipped silently —
  // the process is gone, there is nothing to surface. But a PRESENT candidate (non-null facts)
  // that we can't fully IDENTIFY (identityFor null — e.g. a sustained hog outside the killable
  // allowlist class, or an identity race on the command-hash) is NEVER a killable target, yet
  // it IS a sustained external hog: it MUST be SURFACED, never silently dropped (round-13 —
  // second-pass reviewer: the §4 broad-observability guarantee — no present hog is invisible).
  const enriched: Array<{ c: Candidate; facts: ExternalHogFacts; id: { commandHash: string; ledgerKey: string; classId: string }; tuple: { pid: number; startTime: string; commandHash: string }; coreEquivalents: number }> = [];
  for (const c of tick.candidates) {
    const facts = deps.factsFor(c);
    if (!facts) continue; // vanished → nothing to surface (safe)
    const id = deps.identityFor(c, facts);
    if (!id) {
      // Present sustained hog, not kill-eligible → surface (observability), never classify/kill.
      notices.push({ cls: 'hog-left-alive', signature: `${c.pid} ${c.startTime}`, text: `sustained external hog (not kill-eligible): pid ${c.pid}` });
      continue;
    }
    enriched.push({ c, facts, id, tuple: { pid: c.pid, startTime: c.startTime, commandHash: id.commandHash }, coreEquivalents: c.coreEquivalents });
  }

  const { toClassify, degradedToAlert } = selectForClassification(enriched, opts.maxClassificationsPerScan);

  for (const cand of toClassify) {
    const floor = evaluateKillFloor(cand.facts);
    const raw = await deps.classify(cand.facts);
    const verdict = parseClassifierVerdict(raw); // null → decider-unavailable → alert

    // The §4 observability floor: a deterministic sustained hog that is NOT killed is ALWAYS
    // surfaced (the model can never silence it).
    const surfaceLeftAlive = () => notices.push({ cls: 'hog-left-alive', signature: cand.id.ledgerKey, text: `sustained hog left alive: pid ${cand.c.pid}` });

    if (verdict === null) {
      // Decider unavailable → no kill → alert.
      outcomes.push({ pid: cand.c.pid, verdict: 'decider-unavailable', outcome: 'alert-only' });
      notices.push({ cls: 'decider-unavailable', signature: cand.id.ledgerKey, text: `decider unavailable: pid ${cand.c.pid}` });
      continue;
    }

    if (verdict !== 'kill' || !floor.permitted) {
      // Model spared it, or the floor vetoes → alert-only (observability floor still surfaces).
      outcomes.push({ pid: cand.c.pid, verdict, outcome: 'alert-only' });
      surfaceLeftAlive();
      if (!floor.permitted) notices.push({ cls: 'floor-veto-downgrade', signature: cand.id.ledgerKey, text: `floor vetoed a kill: pid ${cand.c.pid}` });
      continue;
    }

    // verdict === 'kill' && floor permits. Check the P19 breaker before acting.
    const tripped = isBreakerTripped(ledger, cand.id.ledgerKey, cand.id.classId, { ...opts.breaker, nowMs: now });
    if (tripped) {
      outcomes.push({ pid: cand.c.pid, verdict, outcome: 'alert-only' });
      surfaceLeftAlive(); // shielded from KILL only, never from surfacing
      continue;
    }

    // Run the kill funnel (watch-only unless armed → would-kill, no signal).
    const target: KillTarget = { pid: cand.c.pid, startTime: cand.c.startTime, commandHash: cand.id.commandHash, classId: cand.id.classId };
    const funnelOpts: KillFunnelOpts = { ...opts.killFunnel, currentDeferrals: deps.deferralsFor(cand.id.ledgerKey) };
    const outcome = await runKillFunnel(target, funnelOpts, deps.killFunnelDeps);
    outcomes.push({ pid: cand.c.pid, verdict, outcome });

    if (outcome.action === 'killed') {
      ledger = recordKill(ledger, { key: cand.id.ledgerKey, classId: cand.id.classId, atMs: now }, opts.killLedgerRetentionMs, now);
      notices.push({ cls: 'kill', signature: cand.id.ledgerKey, text: `auto-killed zombie: pid ${cand.c.pid}` });
    } else {
      // would-kill (watch-only) / deferred / aborted / sigterm-exited → surface as left-alive.
      surfaceLeftAlive();
    }
  }

  // The over-cap remainder degrades to alert-only (observability floor).
  for (const cand of degradedToAlert) {
    outcomes.push({ pid: cand.c.pid, verdict: 'decider-unavailable', outcome: 'alert-only' });
    notices.push({ cls: 'hog-left-alive', signature: cand.id.ledgerKey, text: `sustained hog left alive (over cap): pid ${cand.c.pid}` });
  }

  const coalesced = coalesceNotices(notices, { budgetPerWindow: opts.noticeBudgetPerWindow });
  return { nextState: { sampler: nextSampler, ledger }, outcomes, notices: coalesced };
}
