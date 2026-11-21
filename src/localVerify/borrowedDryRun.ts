/**
 * The dry run of a borrowed helper (docs/specs/local-verify-borrowed-slices-count.md, "The dry
 * run" and "Build decisions": "The scaling session starts a dry run through a route on the run
 * machine"). It consumes the request `POST /local-verify/borrowed/dry-run` records.
 *
 * One per helper, on a merged commit this machine verified green (the newest kept baseline, pinned
 * until the dry run ends), possibly over several idle periods: the helper's own governor decides
 * when it works, and files it hands back are sent again later. It sends every eligible file of each
 * requested lane once, as compare-only slices marked `dryRun` (base and head are that commit), and
 * compares each answer with the baseline results for that commit:
 *  - a helper pass whose digest of test names and outcomes equals the baseline's is "compared";
 *  - the helper failing a file that passed on `main`, or both passing with different digests,
 *    starts the helper's learned list;
 *  - a file with no baseline row (it failed on `main`) is answered but not compared.
 * Per lane it records, through the practice record's one entry point (`recordDryRunResult`), the
 * files eligible then, those compared, and whether the lane is proven (files worth at least half
 * of the lane's time passed), and one measured run (the helper's speed and preparation time).
 * The helper writes its own "dry run done" record from the same slices (C item 3).
 *
 * Self-triggered and bounded: one task per helper at a time; at most 20 slices waiting on the
 * helper at once; status asked every 5 seconds; a stopped request ends the task and tells the
 * helper it is over; the task gives up after 24 hours. Nothing here is on a verify's path.
 */
import crypto from 'node:crypto';
import type { MachineKeyLookup, MachineSigner } from '../core/AppRecordSignatures.js';
import type { HelperClient } from './borrowedClient.js';
import { excludedBy, isBorrowedCanaryFile, laneOfTestFile } from './borrowedEligibility.js';
import { planSlices } from './borrowedPlan.js';
import type { PracticeLane } from './borrowedPractice.js';
import type { BorrowedPracticeStore, HelperRunSummary } from './borrowedState.js';
import { filesDigest } from './borrowedLaneFlow.js';
import type { FileCountsRow, MainFileCountsStore } from './mainFileCounts.js';
import type { HelperTarget } from './helper/helperConfig.js';
import {
  HELPER_LIMITS, parseHelperAnswer, signHelperRequest, verifyHelperAnswer, verifyHelperStatus,
  type HelperCancelRequest, type HelperLearnedRequest, type HelperPerFile, type HelperSliceRequest, type LearnedObservation,
} from './helper/helperProtocol.js';

export const DRY_RUN_LIMITS = Object.freeze({
  /** Slices waiting on the helper at once (its queue holds 200). */
  inFlightSlices: 20,
  pollMs: 5_000,
  /** The tree's preparation is waited for at most this long per lane. */
  prepareWaitMs: 30 * 60_000,
  /** The whole dry run gives up after this long (it is asked again by a new request). */
  maxMs: 24 * 60 * 60_000,
  /** A busy owner: the next try waits this long. */
  ownerBusyWaitMs: 60_000,
  /** A file the helper did not finish is sent again at most this many times. */
  maxSends: 5,
  /** A dry run that could not start (no baseline, no answer) is tried again at most this often. */
  retryMs: 10 * 60_000,
  /** Lane proven: files worth at least this share of the lane's time passed. */
  provenShare: 0.5,
  /** A file with no recorded time is counted as this long. */
  unknownFileMs: 1_000,
});

export interface DryRunDeps {
  client: HelperClient;
  signer: MachineSigner | null;
  keyLookup: () => MachineKeyLookup;
  machineId: string;
  store: BorrowedPracticeStore;
  baseline: MainFileCountsStore;
  /** The commit's test files with this machine's recorded per-file times (null: none recorded). */
  treeFiles(commit: string): Promise<Array<{ file: string; ms: number | null }>>;
  /** The practice record's entry point for a lane's dry-run result. */
  recordDryRunResult(helper: string, lane: PracticeLane, r: { eligible: readonly string[]; compared: readonly string[]; eligibleDigest: string; proven: boolean }): void;
  audit(e: Record<string, unknown>): void;
  evidence?: (row: { kind: 'fired' | 'held'; reason: string; subject: string; context: Record<string, string | number | boolean | null> }) => void;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What one lane of a dry run found. Pure. */
export function judgeDryRunFile(helper: HelperPerFile, row: FileCountsRow | undefined): 'compared' | 'helper-failed-local-passed' | 'digest-differs-both-pass' | 'no-baseline' | 'not-collected' {
  if (!row) return 'no-baseline';
  if (helper.tests < 1 || helper.digest === null) return 'not-collected';
  if (helper.failed > 0) return 'helper-failed-local-passed';
  return helper.digest === row[4] ? 'compared' : 'digest-differs-both-pass';
}

/** A lane is proven when the files that passed on the helper are worth at least half of the lane's time. Pure. */
export function laneProvenByTime(results: ReadonlyArray<{ file: string; passed: boolean }>, ms: (f: string) => number): boolean {
  let all = 0;
  let passed = 0;
  for (const r of results) { const w = ms(r.file); all += w; if (r.passed) passed += w; }
  return all > 0 && passed >= DRY_RUN_LIMITS.provenShare * all;
}

const newId = (): string => crypto.randomBytes(16).toString('hex');

export class BorrowedDryRun {
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly lastTry = new Map<string, number>();

  constructor(private readonly d: DryRunDeps) {}

  private audit(e: Record<string, unknown>): void { try { this.d.audit({ ...e }); } catch { /* @silent-fallback-ok: the audit log never stops a dry run */ } }

  /** Whether a dry run is running for this helper now. */
  isRunning(helper: string): boolean { return this.running.has(helper); }

  /** Every tick: start a requested dry run, stop a stopped one. Never awaited by anything. */
  tick(helpers: readonly HelperTarget[]): void {
    /* @self-action-controller: local-verify-borrowed-dry-run-resend */
    for (const h of helpers) {
      const intent = this.d.store.get(h.machineId).dryRunIntent;
      const run = this.running.get(h.machineId);
      if (run && (!intent || intent.state === 'stopped')) { run.abort.abort(); continue; }
      // `running` with no task here means the server restarted in the middle: the dry run starts over.
      if (run || !intent || (intent.state !== 'requested' && intent.state !== 'running')) continue;
      const last = this.lastTry.get(h.machineId) ?? 0;
      if (this.d.now() - last < DRY_RUN_LIMITS.retryMs && last !== 0) continue;
      this.lastTry.set(h.machineId, this.d.now());
      const abort = new AbortController();
      const done = this.run(h, [...intent.lanes], abort.signal)
        .catch((e) => this.audit({ event: 'borrowed-dry-run-error', helper: h.machineId, detail: String(e instanceof Error ? e.message : e).slice(0, 200) }))
        .finally(() => { this.running.delete(h.machineId); });
      this.running.set(h.machineId, { abort, done });
    }
  }

  /** Stop every running dry run (the server stops). */
  stopAll(): void { for (const r of this.running.values()) r.abort.abort(); }

  private setState(helper: string, state: 'running' | 'done' | 'requested'): void {
    const h = this.d.store.get(helper);
    if (h.dryRunIntent && h.dryRunIntent.state !== 'stopped') h.dryRunIntent = { ...h.dryRunIntent, state };
    try { this.d.store.save(); } catch (e) { this.audit({ event: 'borrowed-state-unwritable', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  }

  private async run(h: HelperTarget, lanes: PracticeLane[], signal: AbortSignal): Promise<void> {
    if (!this.d.signer) { this.audit({ event: 'borrowed-dry-run-waiting', helper: h.machineId, reason: 'no-signer' }); return; }
    const base = this.d.baseline.read();
    const b = base.ok ? base.file.baselines[0] : undefined;
    if (!b) { this.audit({ event: 'borrowed-dry-run-waiting', helper: h.machineId, reason: 'no-baseline' }); return; }
    const status = await this.d.client.status(h, signal, undefined, 10_000);
    if (!status || !status.raw || verifyHelperStatus(status.raw, h.machineId, this.d.keyLookup(), this.d.now())) {
      this.audit({ event: 'borrowed-dry-run-waiting', helper: h.machineId, reason: 'no-answer' });
      return;
    }
    if (!this.d.baseline.pin(b.commit, true)) { this.audit({ event: 'borrowed-dry-run-waiting', helper: h.machineId, reason: 'baseline-not-pinned', commit: b.commit }); return; }
    this.setState(h.machineId, 'running');
    const runAttemptId = newId();
    const startedAt = this.d.now();
    this.audit({ event: 'borrowed-dry-run-start', helper: h.machineId, commit: b.commit, lanes });
    let finished = true;
    try {
      const tree = await this.d.treeFiles(b.commit);
      for (const lane of lanes) {
        if (signal.aborted || this.d.now() - startedAt > DRY_RUN_LIMITS.maxMs) { finished = false; break; }
        const ok = await this.runLane(h, lane, b.commit, b.files, tree, runAttemptId, startedAt, signal);
        if (!ok) { finished = false; break; }
      }
    } finally {
      try {
        const c: HelperCancelRequest = { kind: 'cancel', attemptId: newId(), runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: h.machineId, expiresAt: this.d.now() + HELPER_LIMITS.requestMaxLifetimeMs, verifyOver: true };
        await this.d.client.cancel(h, signHelperRequest(this.d.signer, c), undefined, 10_000);
      } catch (e) { this.audit({ event: 'borrowed-dry-run-error', helper: h.machineId, step: 'cancel', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
      try { this.d.baseline.pin(b.commit, false); } catch { /* @silent-fallback-ok: a pin left behind is released by the next dry run or ages out with newer greens */ }
    }
    const stopped = signal.aborted;
    // Finished: the request is done. Not finished (stopped, or a lane could not end): a stop stays stopped; anything else is asked again later.
    if (finished) this.setState(h.machineId, 'done');
    else if (!stopped) this.setState(h.machineId, 'requested');
    this.audit({ event: 'borrowed-dry-run-end', helper: h.machineId, commit: b.commit, finished, stopped });
    try { this.d.evidence?.({ kind: finished ? 'fired' : 'held', reason: finished ? 'dry-run-done' : stopped ? 'dry-run-stopped' : 'dry-run-unfinished', subject: h.machineId, context: { commit: b.commit, lanes: lanes.join(',') } }); } catch { /* @silent-fallback-ok: a lost evidence row costs a sample */ }
  }

  /** One lane: prepare, send every eligible file once (again if handed back), compare, record. False: the lane could not end. */
  private async runLane(h: HelperTarget, lane: PracticeLane, commit: string, rows: Readonly<Record<string, FileCountsRow>>, tree: ReadonlyArray<{ file: string; ms: number | null }>, runAttemptId: string, startedAt: number, signal: AbortSignal): Promise<boolean> {
    const signer = this.d.signer!;
    const eligible = tree.filter((t) => laneOfTestFile(t.file) === lane && excludedBy(t.file) === null && !isBorrowedCanaryFile(t.file)).map((t) => t.file).sort();
    const localMs = new Map(tree.map((t) => [t.file, t.ms]));
    const ms = (f: string) => localMs.get(f) ?? DRY_RUN_LIMITS.unknownFileMs;
    if (eligible.length === 0) {
      this.d.recordDryRunResult(h.machineId, lane, { eligible: [], compared: [], eligibleDigest: filesDigest([]), proven: false });
      this.audit({ event: 'borrowed-dry-run-lane', helper: h.machineId, lane, eligible: 0 });
      return true;
    }
    const base = () => ({ runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: h.machineId, expiresAt: this.d.now() + HELPER_LIMITS.requestMaxLifetimeMs });
    // Prepare the commit's tree and wait for it.
    const prep: HelperSliceRequest = { kind: 'slice', attemptId: newId(), ...base(), lane, baseSha: commit, headSha: commit, files: [], deadlineAt: this.d.now() + DRY_RUN_LIMITS.maxMs, budgetMs: 1, prepare: true };
    await this.d.client.slice(h, signHelperRequest(signer, prep), 10_000, signal);
    const prepStart = this.d.now();
    let prepMs: number | null = null;
    for (;;) {
      if (signal.aborted) return false;
      const st = await this.d.client.status(h, signal, undefined, 10_000);
      const t = st?.trees.find((x) => x.headSha === commit);
      if (t?.state === 'ready') { prepMs = t.prepMs ?? this.d.now() - prepStart; break; }
      if (t?.state === 'failed' || this.d.now() - prepStart > DRY_RUN_LIMITS.prepareWaitMs) {
        this.audit({ event: 'borrowed-dry-run-lane', helper: h.machineId, lane, prepared: false, reason: t?.reason ?? 'prepare-timeout' });
        return false;
      }
      await this.d.sleep(DRY_RUN_LIMITS.pollMs, signal);
    }
    const pending = [...eligible];
    const sends = new Map<string, number>();
    const answered = new Map<string, HelperPerFile>();
    const refused = new Set<string>();
    const waiting = new Map<string, string[]>();
    let seq = 0;
    let treeHash: string | null = null;
    const tp = 1;
    while ((pending.length > 0 || waiting.size > 0) && !signal.aborted) {
      if (this.d.now() - startedAt > DRY_RUN_LIMITS.maxMs) return false;
      // Fill the helper's queue up to the bound.
      while (pending.length > 0 && waiting.size < DRY_RUN_LIMITS.inFlightSlices) {
        const take = planSlices({ files: pending.map((f) => ({ file: f, ms: ms(f) })), budgetMs: HELPER_LIMITS.sliceBudgetMs[lane], throughput: tp, sendLocalMs: Number.POSITIVE_INFINITY }).slices[0]
          ?? [pending[0]];
        const files = take.slice(0, HELPER_LIMITS.maxFilesPerRequest);
        for (const f of files) { pending.splice(pending.indexOf(f), 1); sends.set(f, (sends.get(f) ?? 0) + 1); }
        const req: HelperSliceRequest = {
          kind: 'slice', attemptId: newId(), ...base(), lane, baseSha: commit, headSha: commit, files,
          deadlineAt: this.d.now() + DRY_RUN_LIMITS.maxMs, budgetMs: HELPER_LIMITS.sliceBudgetMs[lane], use: 'compare', dryRun: true,
        };
        const r = await this.d.client.slice(h, signHelperRequest(signer, req), 10_000, signal);
        const ans = r ? parseHelperAnswer(r.body) : null;
        if (ans?.state === 'queued') { waiting.set(req.attemptId, files); continue; }
        const reason = String((r?.body as { reason?: unknown } | null)?.reason ?? ans?.state ?? 'no-answer');
        // Busy or unreachable: the files go back; a refusal of the files themselves is recorded once.
        if (reason === 'file-ineligible' || reason === 'file-missing' || reason === 'file-wrong-lane') { for (const f of files) refused.add(f); continue; }
        for (const f of files) if ((sends.get(f) ?? 0) < DRY_RUN_LIMITS.maxSends) pending.push(f); else refused.add(f);
        await this.d.sleep(DRY_RUN_LIMITS.ownerBusyWaitMs, signal);
        break;
      }
      if (waiting.size === 0) continue;
      await this.d.sleep(DRY_RUN_LIMITS.pollMs, signal);
      const st = await this.d.client.status(h, signal, { run: runAttemptId, since: seq }, 10_000);
      if (!st || !st.raw || verifyHelperStatus(st.raw, h.machineId, this.d.keyLookup(), this.d.now())) continue;
      for (const x of st.results) {
        if (x.seq > seq) seq = x.seq;
        const a = parseHelperAnswer(x.answer);
        if (!a || !waiting.has(a.attemptId) || a.state === 'queued' || a.state === 'preparing') continue;
        const files = waiting.get(a.attemptId)!;
        waiting.delete(a.attemptId);
        const sig = verifyHelperAnswer(a, h.machineId, this.d.keyLookup(), this.d.now());
        const okIds = a.runAttemptId === runAttemptId && a.baseSha === commit && a.headSha === commit && a.lane === lane;
        if (sig || !okIds) { this.audit({ event: 'borrowed-answer-invalid', helper: h.machineId, attemptId: a.attemptId, reason: sig ?? 'ids', dryRun: true }); }
        else {
          if (a.treeHash) treeHash = a.treeHash;
          const trouble = !a.slice || a.slice.unhandledErrors > 0 || (a.slice.exitCode !== 0 && !a.perFile.some((p) => p.failed > 0));
          if (!trouble) for (const p of a.perFile) if (files.includes(p.file)) answered.set(p.file, p);
        }
        // Whatever the helper did not finish goes again (a few times at most).
        for (const f of files) if (!answered.has(f)) { if ((sends.get(f) ?? 0) < DRY_RUN_LIMITS.maxSends) pending.push(f); else refused.add(f); }
      }
    }
    if (signal.aborted) return false;
    const compared: string[] = [];
    const observations: LearnedObservation[] = [];
    let helperMs = 0;
    let localKnownMs = 0;
    for (const [f, p] of answered) {
      const v = judgeDryRunFile(p, rows[f]);
      if (v === 'compared') compared.push(f);
      if (v === 'helper-failed-local-passed' || v === 'digest-differs-both-pass') observations.push({ file: f, kind: v });
      const known = localMs.get(f);
      if (typeof known === 'number') { helperMs += p.ms; localKnownMs += known; }
    }
    const proven = laneProvenByTime([...answered.values()].map((p) => ({ file: p.file, passed: p.tests > 0 && p.failed === 0 })), ms);
    this.d.recordDryRunResult(h.machineId, lane, { eligible, compared, eligibleDigest: filesDigest(eligible), proven });
    // The helper's measured speed and preparation time (the share and the plan read them).
    const run: HelperRunSummary = { at: this.d.now(), counted: helperMs > 0, slicesSent: eligible.length, done: answered.size, agree: compared.length, disagree: observations.length, helperMs, localMs: localKnownMs, prepMs, vitestStartMs: null };
    this.d.store.addRun(h.machineId, run);
    try { this.d.store.save(); } catch (e) { this.audit({ event: 'borrowed-state-unwritable', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
    if (observations.length > 0 && treeHash) {
      const l: HelperLearnedRequest = { kind: 'learned', attemptId: newId(), ...base(), treeHash, observations: observations.slice(0, HELPER_LIMITS.maxFilesPerRequest) };
      try { await this.d.client.learned(h, signHelperRequest(signer, l)); } catch (e) { this.audit({ event: 'borrowed-dry-run-error', helper: h.machineId, step: 'learned', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
    }
    this.audit({
      event: 'borrowed-dry-run-lane', helper: h.machineId, lane, commit, eligible: eligible.length, answered: answered.size, compared: compared.length,
      learned: observations.length, noBaseline: [...answered.keys()].filter((f) => !rows[f]).length, refused: refused.size, proven, prepMs,
      helperSec: Math.round(helperMs / 100) / 10, localSec: Math.round(localKnownMs / 100) / 10,
      ...(observations.length > 0 || refused.size > 0 ? { learnedFiles: observations.map((o) => o.file).slice(0, 200), refusedFiles: [...refused].slice(0, 200) } : {}),
    });
    return true;
  }
}
