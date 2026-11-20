/**
 * The shadow fold runner (context-budget-layered-summaries §16 Phase 2, §7.1–
 * §7.5, §9.3 step 0 "Prepare" for shadow handoffs, §10 shadow mode; Phase 2
 * slice P2-4b).
 *
 * On a live topic session's turn end (and a slow sweep), behind
 * `contextBudget.fold.shadow`, for a Claude Code session on a topic this
 * machine owns:
 *
 *   1. brakes (2 asks/hour, 30-min backoff, 1 in 3 clean stops) — before any
 *      read that costs anything;
 *   2. the benefit estimate (§7.2): unknown or below the margin ⇒ skip;
 *   3. the clean stop (§7.3): any unknown ⇒ skip, recorded;
 *   4. PREPARE (§9.3 step 0): a `prepared` fold record (the coordinator's
 *      preconditions: owner, sentinel heartbeat, live inbound queue, rows), the
 *      fold hold, the live session's marker and the inbound hold — each written
 *      before the next, any failure aborts the record;
 *   5. the handoff turn: the internal request injected; its reply read within
 *      the handoff bound (the lock renewed while waiting); the lock window
 *      recorded; parse → verify → audit (send back at most per policy);
 *   6. RELEASE the live session at once (hold, ITS marker only, inbound), then
 *      `prepared → shadow-probing`: from here the live session is untouched;
 *   7. the packet built, verified and staged (staged-fold-packet carrier);
 *      probe material, questions, the throwaway answerer, grades, roll-up;
 *   8. one record row; `shadow-probing → aborted` with reason `shadow-graded`
 *      (aborted-by-design: settle releases the staged packet and the
 *      answerer's marker).
 *
 * Every exit writes exactly one row and leaves the record terminal. Nothing
 * here replaces any context: that is `contextBudget.fold.enabled`, which this
 * runner never reads.
 */
import type { IntelligenceProvider } from '../core/types.js';
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import type { FoldRecord, TransitionResult } from './FoldCoordinator.js';
import type { LayerStore } from './contextLayers/LayerStore.js';
import type { PacketRowSource } from './contextLayers/standingPacket.js';
import type { SpanEntry } from './contextLayers/spanSampler.js';
import type { TopicIntentFile } from '../core/TopicIntent.js';
import { parseHandoff, verifyHandoff, buildHandoffRequest, type ContextMessage, type IndexMessage, type Handoff } from './foldHandoff.js';
import { buildFoldPacket, verifyFoldPacket, stageFoldPacket, type TailItem } from './foldPacket.js';
import { selectProbeMaterial, generateProbeQuestions, type ProbeItems, type FoldedSpan, type ProbeQuestion } from './foldProbe.js';
import { gradeAnswer, rollUp, type GradeResult } from './foldGrade.js';
import { runShadowAnswerer, type AnswererDeps } from './foldShadowAnswerer.js';
import { auditHandoff, checkSignals, nextAuditStep, droppedDecisions, type ArtifactSignal, type LedgerDecision } from './foldAudit.js';
import { cleanStop, brakeOnStop, recordAsk, recordBackoff, type CleanStopEvidence, type Tri } from './foldCleanStop.js';
import { appendShadowFold, type ShadowFoldRow } from './foldShadowLog.js';
import { writeFoldMarker, removeFoldMarkerFor } from './foldMarker.js';
import type { BenefitEstimate } from './foldBenefit.js';

export const RUNNER_DEFAULTS = {
  /** The handoff turn's wall-clock bound (§9.3: every step has its own bound). */
  handoffBoundMs: 5 * 60_000,
  /** The clean-stop check-in distance uses this as the fold duration (Phase 0 measured; §7.3 × 2). */
  foldDurationMs: 15 * 60_000,
  messageIndex: 200,
  /** A pre-PNR record this old has outlived any lock (the 30-minute lock ceiling) and is reconciled. */
  staleAfterMs: 30 * 60_000,
} as const;

export interface LiveTopicSession {
  topicKey: string;
  tmuxSession: string;
  /** INSTAR_SESSION_ID: the fold marker's key. */
  instarSessionId: string;
  claudeSessionId: string | null;
  framework: string;
  model?: string;
}

export interface ShadowRunnerDeps {
  stateDir: string;
  enabled(): boolean;
  now(): number;
  coordinator: {
    begin(topicKey: string, mode: 'prepare'): { ok: true; record: FoldRecord } | { ok: false; reason: string };
    transition(topicKey: string, foldId: string, expect: { state: FoldRecord['state']; seq: number; generation: number }, to: FoldRecord['state'], patch?: Partial<FoldRecord>): TransitionResult;
    setLockWindow(topicKey: string, foldId: string, b: { fromEntry?: string; toEntry?: string }): boolean;
    renew(topicKey: string, foldId: string, expect: { generation: number }): boolean;
    reconcileStale(topicKey: string, olderThanMs: number): FoldRecord[];
  };
  holds: { write(topicKey: string, foldId: string, expiresAt: number): boolean; release(topicKey: string, foldId: string): void };
  inbound: { holdForFold(topicKey: string, foldId: string): boolean; releaseFold(foldId: string): void; waiting(topicKey: string): number | null };
  session: {
    exists(s: LiveTopicSession): Tri;
    paneIdle(s: LiveTopicSession): Promise<Tri>;
    liveToolShell(s: LiveTopicSession): Tri;
    liveHelpers(s: LiveTopicSession): Tri;
    pendingInjection(s: LiveTopicSession): boolean;
    inject(s: LiveTopicSession, text: string): Promise<boolean>;
    /** The reply text of the session's next turn end, or null at the bound. */
    awaitTurnEnd(s: LiveTopicSession, boundMs: number, onTick: () => void): Promise<string | null>;
  };
  transcript: {
    /** The session's transcript text (bounded read), or null. */
    read(s: LiveTopicSession): Promise<string | null>;
    lastEntryId(jsonl: string): string | null;
    openBackgroundTasks(jsonl: string): number;
  };
  nextCheckInAt(topicKey: string): number | null | undefined;
  estimate(s: LiveTopicSession): BenefitEstimate;
  /** TopicMemory rows of the topic (bounded, oldest first). */
  messages(topicKey: string, limit: number): Array<ContextMessage & IndexMessage>;
  archivedEntryIds(topicKey: string): ReadonlySet<string>;
  /** Archived span entries for each finished stretch the verified handoff names. */
  foldedSpans(topicKey: string, finished: Handoff['finished']): FoldedSpan[];
  artifactSignals(topicKey: string, h: Handoff): { signals: ArtifactSignal[]; mergedNotMentioned: string[] };
  packetInputs(topicKey: string): { store: LayerStore; rows: PacketRowSource; intent: TopicIntentFile | null; anchorText: string; ledgerText: string; ledgerItems: ProbeItems['ledger']; ledgerDecisions: LedgerDecision[] };
  intelligence: IntelligenceProvider | null;
  answerer: AnswererDeps;
  log?: (row: Omit<ShadowFoldRow, 't'>) => void;
  /** A fold that could not be closed or a step that threw: reported, never silent. */
  onDegraded?: (e: { topicKey: string; foldId: string | null; reason: string }) => void;
}

type Row = Omit<ShadowFoldRow, 't'>;

export async function runShadowFoldOnStop(d: ShadowRunnerDeps, s: LiveTopicSession): Promise<Row | null> {
  if (!d.enabled() || s.framework !== CLAUDE_CODE_FRAMEWORK || !/^\d{1,15}$/.test(s.topicKey)) return null;
  const started = d.now();
  const durations: Record<string, number> = {};
  const calls: Record<string, number> = { FoldAudit: 0, FoldProbe: 0, answerer: 0, handoffTurns: 0 };
  const base = { at: started, topicKey: s.topicKey, engine: s.framework } as const;
  const write = (row: Row): Row => { (d.log ?? ((r) => appendShadowFold(d.stateDir, r)))(row); return row; };
  const skip = (reason: string, extra: Partial<Row> = {}): Row => write({ ...base, foldId: null, outcome: 'skipped', reason, ...extra });

  // 1. Brakes first: cheapest, and they only ever make asking rarer.
  const brake = brakeOnStop(d.stateDir, s.topicKey, started, { shadow: true });
  if (!brake.ask) return brake.reason === 'not-sampled' ? null : skip(brake.reason);

  // 2. Benefit (§7.2): unknown or below the margin ⇒ no ask.
  const est = d.estimate(s);
  if (est.status !== 'ok') return skip(`estimate-unknown: ${est.reason}`);
  const estimate = { breakEvenTurns: est.breakEvenTurns, expectedRemainingTurns: est.expectedRemainingTurns, cost: est.cost, savingPerTurn: est.savingPerTurn };
  if (!est.worthAsking) return skip(est.belowFloor ? 'below-floor' : 'below-margin', { estimate });

  // 3. Clean stop (§7.3).
  const jsonl = await d.transcript.read(s);
  const evidence: CleanStopEvidence = {
    sessionExists: d.session.exists(s),
    paneIdle: await d.session.paneIdle(s),
    liveToolShell: d.session.liveToolShell(s),
    liveHelpers: d.session.liveHelpers(s),
    openBackgroundTasks: jsonl === null ? null : d.transcript.openBackgroundTasks(jsonl),
    waitingUserMessages: d.session.pendingInjection(s) ? 1 : d.inbound.waiting(s.topicKey),
    nextCheckInAt: d.nextCheckInAt(s.topicKey),
    now: started,
    foldDurationMs: RUNNER_DEFAULTS.foldDurationMs,
  };
  const stop = cleanStop(evidence);
  if (!stop.clean) return skip(`not-clean: ${stop.reason}`, { estimate });

  // 4. PREPARE. First, close this machine's own stale record for the topic (a fold whose close
  // was refused earlier and whose lock ceiling has passed), so one stranded record never ends
  // shadow folding on the topic for good. Then the record, then each carrier in order.
  for (const r of d.coordinator.reconcileStale(s.topicKey, RUNNER_DEFAULTS.staleAfterMs)) d.onDegraded?.({ topicKey: s.topicKey, foldId: r.foldId, reason: r.reason ?? 'reconciled-stale' });
  const begun = d.coordinator.begin(s.topicKey, 'prepare');
  if (!begun.ok) return skip(`fold-skipped: ${begun.reason}`, { estimate });
  let rec = begun.record;
  const foldId = rec.foldId;
  let ended: Row | null = null;
  const guard = (what: string, f: () => void) => {
    try { f(); } catch (e) { d.onDegraded?.({ topicKey: s.topicKey, foldId, reason: `release-threw: ${what} ${e instanceof Error ? e.name : 'error'}` }); }
  };
  const end = (outcome: Row['outcome'], reason: string, extra: Partial<Row> = {}): Row => {
    if (ended) return ended; // never twice: a throw after a successful close must not re-run it
    // Release the live session's carriers, each on its own (one failing never skips the rest or
    // the close), then ALWAYS attempt the terminal transition, whose settle releases every
    // registered carrier again.
    guard('hold', () => d.holds.release(s.topicKey, foldId));
    guard('marker', () => { removeFoldMarkerFor(d.stateDir, s.instarSessionId, foldId); });
    guard('inbound', () => d.inbound.releaseFold(foldId));
    let done: ReturnType<ShadowRunnerDeps['coordinator']['transition']>;
    try { done = d.coordinator.transition(s.topicKey, foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, 'aborted', { reason }); }
    catch (e) { done = { ok: false, reason: `transition-threw: ${e instanceof Error ? e.name : 'error'}` }; }
    durations.total = d.now() - started;
    if (!done.ok) {
      // The record could not go terminal (ownership moved, the session left, the epoch changed): the
      // live carriers are already released above; the record waits for the owner's sweep (§9.3
      // Fencing). Say so in the row and to the degradation report, never a silent "aborted".
      d.onDegraded?.({ topicKey: s.topicKey, foldId, reason: `terminal-refused: ${done.reason}` });
      ended = { ...base, foldId, outcome: 'aborted', reason: `terminal-refused: ${done.reason}`, estimate, durations, calls, ...extra };
    } else {
      ended = { ...base, foldId, outcome, reason: outcome === 'graded' ? null : reason, estimate, durations, calls, ...extra };
    }
    guard('row', () => { write(ended!); });
    return ended;
  };
  try {
    const expires = started + RUNNER_DEFAULTS.handoffBoundMs * 3;
    if (!d.holds.write(s.topicKey, foldId, expires)) return end('aborted', 'hold-write-failed');
    if (!writeFoldMarker(d.stateDir, { instarSessionId: s.instarSessionId, foldId, topicKey: s.topicKey, expiresAt: expires }, started)) return end('aborted', 'marker-write-failed');
    if (!d.inbound.holdForFold(s.topicKey, foldId)) return end('aborted', 'inbound-hold-failed');
    recordAsk(d.stateDir, s.topicKey, started);

    // 5. The handoff turn (with at most the policy's send-backs).
    const messages = d.messages(s.topicKey, RUNNER_DEFAULTS.messageIndex);
    const archived = d.archivedEntryIds(s.topicKey);
    const t0 = d.now();
    const fromEntry = jsonl ? d.transcript.lastEntryId(jsonl) : null;
    if (fromEntry) d.coordinator.setLockWindow(s.topicKey, foldId, { fromEntry });
    let questions: string[] | undefined;
    let sendBacks = 0;
    let handoff: Handoff | null = null;
    let verification: ReturnType<typeof verifyHandoff> | null = null;
    let demoted: number[] = [];
    const inputs = d.packetInputs(s.topicKey);
    for (;;) {
      calls.handoffTurns++;
      if (!(await d.session.inject(s, buildHandoffRequest({ foldId, messages, questions })))) return end('aborted', 'inject-failed');
      // Renew while the turn runs, and re-stamp the live session's marker after each renewal (§9.3).
      const reply = await d.session.awaitTurnEnd(s, RUNNER_DEFAULTS.handoffBoundMs, () => {
        if (d.coordinator.renew(s.topicKey, foldId, { generation: rec.generation })) writeFoldMarker(d.stateDir, { instarSessionId: s.instarSessionId, foldId, topicKey: s.topicKey, expiresAt: d.now() + RUNNER_DEFAULTS.handoffBoundMs * 3 }, d.now());
      });
      if (reply === null) { recordBackoff(d.stateDir, s.topicKey, d.now()); return end('declined', 'handoff-timeout'); }
      const parsed = parseHandoff(reply);
      if (!parsed.ok) { recordBackoff(d.stateDir, s.topicKey, d.now()); return end('declined', `handoff-unparseable: ${parsed.reason}`); }
      handoff = parsed.value;
      verification = verifyHandoff(handoff, { messages, archivedEntryIds: archived, backgroundEvidence: evidence.openBackgroundTasks ? 'live' : 'none' });
      const sig = d.artifactSignals(s.topicKey, handoff);
      const check = checkSignals(handoff, sig.signals, sig.mergedNotMentioned);
      calls.FoldAudit++;
      const audit = await auditHandoff({ intelligence: d.intelligence }, { handoff, anchorText: inputs.anchorText, ledgerText: inputs.ledgerText, check });
      if (audit.status === 'no-judge') return end('aborted', 'no-judge');
      if (audit.status === 'invalid') return end('aborted', `audit-invalid: ${audit.detail}`);
      const dropped = droppedDecisions(handoff, inputs.ledgerDecisions);
      const step = nextAuditStep(sendBacks, audit.verdict, check, { protectedDefect: dropped.keys.length > 0, droppedSpans: dropped.spans });
      if (step.action === 'decline') return end('declined', 'fold-declined: audit');
      const deficiencyQs = verification.deficiencies.map((x) => `${x.code}: ${x.detail}`);
      if (step.action === 'accept' && verification.ok) break;
      if (step.action === 'send-back' || (!verification.ok && sendBacks < 1)) { sendBacks++; questions = [...audit.verdict.questions, ...deficiencyQs, ...dropped.keys.map((k) => `decision ${k} is in a stretch you called finished but is not quoted or kept`)]; continue; }
      // A still-deficient handoff: demote the contested spans to the verbatim tail (§7.4).
      demoted = step.spans;
      if (!verification.ok) return end('declined', 'fold-declined: audit (handoff still deficient)');
      break;
    }
    durations.handoff = d.now() - t0;
    const after = await d.transcript.read(s);
    const toEntry = after ? d.transcript.lastEntryId(after) : null;
    if (toEntry) d.coordinator.setLockWindow(s.topicKey, foldId, { toEntry });

    // 6. Release the live session at once, then shadow-probing (§9.3 step 0).
    d.holds.release(s.topicKey, foldId);
    removeFoldMarkerFor(d.stateDir, s.instarSessionId, foldId);
    d.inbound.releaseFold(foldId);
    const moved = d.coordinator.transition(s.topicKey, foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, 'shadow-probing');
    if (!moved.ok) return end('aborted', `transition-refused: ${moved.reason}`);
    rec = moved.record;

    // 7. Packet → probe → answerer → grades.
    const finished = handoff!.finished.filter((_, i) => !demoted.includes(i));
    const v = verifyHandoff({ ...handoff!, finished }, { messages, archivedEntryIds: archived, backgroundEvidence: 'none' });
    const tail: TailItem[] = [...v.coverage.unclassified, ...v.coverage.tail].sort((a, b) => a - b).map((id) => {
      const m = messages.find((x) => x.messageId === id)!;
      return m.fromUser ? { kind: 'operator', messageId: id } : { kind: 'agent', messageId: id, text: m.text };
    });
    const t1 = d.now();
    const packet = buildFoldPacket({ store: inputs.store, rows: inputs.rows, topicKey: s.topicKey, foldId, handoff: v, narrative: { openThreads: handoff!.openThreads, nextStep: handoff!.nextStep, background: handoff!.background, finished }, tail, intent: inputs.intent, now: d.now() });
    const pv = verifyFoldPacket(packet, inputs.rows);
    const packetRow = { bytes: packet.bytes, problems: pv.problems.map((p) => p.problem) };
    const handoffRow = { deficiencies: v.deficiencies.map((x) => x.code), relabels: v.relabels.length, sendBacks, demoted: demoted.length };
    if (!pv.ok) return end('aborted', 'packet-refused', { packet: packetRow, handoff: handoffRow });
    stageFoldPacket(d.stateDir, packet, pv, { lastEntryId: toEntry, now: d.now() });
    durations.packet = d.now() - t1;

    const t2 = d.now();
    const spans = d.foldedSpans(s.topicKey, finished);
    const ledgerIds = v.decisions.flatMap((x) => (x.boundMessageId === null ? [] : [x.boundMessageId]));
    const keptOperator = v.items.flatMap((x) => (x.origin === 'user' && x.messageId !== undefined ? [x.messageId] : []));
    const keptTool = v.items.flatMap((x) => (x.origin === 'tool' && x.entryId ? [x.entryId] : []));
    const material = selectProbeMaterial({ foldId, spans, floorMessageIds: [...ledgerIds, ...keptOperator], floorEntryIds: keptTool });
    const items: ProbeItems = { ledger: inputs.ledgerItems, stillNeeded: v.items.map((x) => x.text), openThreads: handoff!.openThreads, nextStep: handoff!.nextStep, finished: finished.map((f, i) => ({ index: i, outcome: f.outcome })) };
    calls.FoldProbe++;
    const gen = await generateProbeQuestions({ intelligence: d.intelligence }, material, items, { foldId });
    calls.FoldProbe += gen.calls > 1 ? gen.calls - 1 : 0;
    if (gen.status === 'no-judge') return end('aborted', 'no-judge', { packet: packetRow, handoff: handoffRow });
    if (gen.status === 'error' || gen.status === 'unparseable') return end('aborted', `probe-${gen.status}`, { packet: packetRow, handoff: handoffRow });
    const qs: ProbeQuestion[] = gen.questions;
    const byType: Record<string, number> = {};
    for (const q of qs) byType[q.type] = (byType[q.type] ?? 0) + 1;
    const probeRow = { questions: qs.length, byType, independent: gen.validation.independentQuestions, coverage: material.coverage };

    calls.answerer++;
    const ans = await runShadowAnswerer(d.answerer, { topicKey: s.topicKey, foldId, packetText: packet.text, questions: qs, model: s.model });
    durations.probe = d.now() - t2;
    if (ans.status !== 'answered') return end('aborted', `answerer-${ans.status}`, { packet: packetRow, handoff: handoffRow, probe: probeRow });

    const refText = (q: ProbeQuestion) => q.referenceEntryIds.map((id) => [...material.named.entries, ...material.independent].find((e) => e.entryId === id)?.text ?? '').join('\n');
    const protectedSource = (q: ProbeQuestion) => q.source === 'ledger' || (q.source === 'still-needed' && v.items[Number(q.sourceRef)]?.origin === 'user');
    const grades: GradeResult[] = [];
    for (const q of qs) {
      const a = ans.answers.find((x) => x.questionId === q.id) ?? { questionId: q.id, answer: '', lookups: [] };
      calls.FoldProbe++;
      grades.push(await gradeAnswer({ intelligence: d.intelligence }, { question: q, answer: a, reference: refText(q), packetText: packet.text, itemBytes: q.source === 'still-needed' ? v.items[Number(q.sourceRef)]?.text ?? null : null, protectedClass: protectedSource(q) }));
    }
    const verdict = rollUp(grades);
    return end('graded', 'shadow-graded', {
      packet: packetRow, handoff: handoffRow, probe: probeRow,
      grades: { retained: verdict.counts.retained, retrievable: verdict.counts.retrievable, lost: verdict.counts.lost, ungraded: verdict.counts.ungraded, lostRate: verdict.lostRate, wouldBe: verdict.outcome, protectedLost: grades.some((g) => g.final === 'lost' && g.protectedClass) },
    });
  } catch (e) {
    // A step threw (a store read, an inject, a builder): release the live session's carriers and
    // close the record, so the conversation is never left muted in either direction.
    const why = e instanceof Error ? e.name : 'error';
    d.onDegraded?.({ topicKey: s.topicKey, foldId, reason: `step-threw: ${why}` });
    return end('aborted', 'step-threw');
  }
}

/** Unused-type guard for SpanEntry in signatures kept for the wiring slice. */
export type { SpanEntry };
