/**
 * The run machine's side of borrowed helpers, SHADOW ONLY (docs/specs/local-verify-borrowed-unit-slices.md, F).
 *
 * With `monitoring.localVerify.borrowed.mode` at `'practice'` or `'count'` (the first design's
 * `'shadow'` reads as `'practice'`), each of this machine's own `main` verifies
 * sends eligible unit files to its helpers while its own unit lane runs every file as always, and
 * compares file by file after the run's record is written. A helper result has exactly one use,
 * comparison: no code path here feeds anything into `evaluateRun` or a record.
 *
 * The shadow client cannot disturb the verify it rides on (`main` verifies decide main health and
 * the main-red hold):
 *  - it is a detached task the run never awaits (MainRunObserver callbacks return void at once);
 *  - every failure in prepare, poll, slice, cancel, compare, learned post or audit is caught and
 *    audited `borrowed-shadow-error`, never thrown into the run;
 *  - comparison happens only after the record is written;
 *  - a client that hangs is abandoned at the end of the unit lane (its requests are aborted).
 *
 * Asking the helper (docs/specs/local-verify-borrowed-slices-count.md, F): one status request with
 * a 2-second limit at the start of the verify, made INSIDE this detached task; its whole-status
 * signature must hold. A helper that stays silent is asked less often (borrowedAsk.ts), which
 * replaces the first design's back-off of up to 8 hours.
 */
import crypto from 'node:crypto';
import type { MachineKeyLookup, MachineSigner } from '../core/AppRecordSignatures.js';
import type { FileCounts } from './laneReport.js';
import type { MainRunEnd, MainRunObserver, MainRunStart } from './mainRunObserver.js';
import { judgeEligibility, scanHitShare, type TreeReader } from './borrowedEligibility.js';
import { BORROWED_CANARY, BORROWED_CANARY_FILES } from './borrowedCanary.js';
import { BORROWED_PLAN, nextBudgetMs, planSlices, sendAmountMs, seededThroughput } from './borrowedPlan.js';
import { compareShadow, type SentSlice } from './borrowedCompare.js';
import { BorrowedPracticeStore, measuredPrepP90, measuredThroughput } from './borrowedState.js';
import { HelperAsking } from './borrowedAsking.js';
import type { HelperClient, HelperStatusView } from './borrowedClient.js';
import type { BorrowedConfig, HelperTarget } from './helper/helperConfig.js';
import {
  HELPER_LIMITS, parseHelperAnswer, signHelperRequest, verifyHelperAnswer,
  type HelperCancelRequest, type HelperLearnedRequest, type HelperSliceRequest,
} from './helper/helperProtocol.js';

export interface BorrowedShadowDeps {
  config: () => BorrowedConfig;
  client: HelperClient;
  signer: MachineSigner | null;
  keyLookup: () => MachineKeyLookup;
  machineId: string;
  stateDir: string;
  version: string;
  localWorkers: number;
  /** The head's unit files with this machine's recorded durations (ms). */
  unitFiles(headSha: string): Promise<Array<{ file: string; ms: number }>>;
  treeReader(headSha: string): TreeReader;
  /** This run's own unit-lane per-file counts, read after the record is written. */
  localUnitReport(headSha: string): Promise<ReadonlyMap<string, FileCounts> | null>;
  audit(event: Record<string, unknown>): void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** The practice record, shared with the server's side of waiting changes' verifies. Absent: this observer opens the file itself. */
  store?: BorrowedPracticeStore;
  /** The asking bookkeeping, shared the same way. Absent: built here on `store`. */
  asking?: HelperAsking;
}

interface RunCtx {
  headSha: string;
  runToken: string;
  runAttemptId: string;
  startedAt: number;
  unitEndAt: number;
  abort: AbortController;
  ended: Promise<MainRunEnd>;
  resolveEnded: (e: MainRunEnd) => void;
  tasks: Promise<void>[];
}

const newId = (): string => crypto.randomBytes(16).toString('hex');

export class BorrowedShadow implements MainRunObserver {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly store: BorrowedPracticeStore;
  private readonly asking: HelperAsking;
  private readonly runs = new Map<string, RunCtx>();
  private readonly lastSummary = new Map<string, Record<string, unknown>>();
  private readonly lastLearned = new Map<string, { entries: number; incompatible: boolean; files: string[] }>();
  private readonly seenScanHits = new Set<string>();
  private readonly budgets = new Map<string, { budgetMs: number; vitestStarts: number[] }>();
  /** Dry-run coverage per helper (files already compared in a dry run, this process). */
  private readonly dryRunCovered = new Map<string, Set<string>>();

  constructor(private readonly d: BorrowedShadowDeps) {
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? ((ms, signal) => new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    }));
    this.store = d.store ?? new BorrowedPracticeStore(d.stateDir);
    this.asking = d.asking ?? new HelperAsking({ store: this.store, client: d.client, keyLookup: d.keyLookup, audit: (e) => this.audit(e), now: this.now });
  }

  private audit(e: Record<string, unknown>): void {
    try { this.d.audit(e); } catch { /* @silent-fallback-ok: the audit log never breaks a verify */ }
  }

  private error(step: string, helper: string | null, e: unknown): void {
    this.audit({ event: 'borrowed-shadow-error', step, ...(helper ? { helper } : {}), detail: String(e instanceof Error ? e.message : e).slice(0, 300) });
  }

  // ── MainRunObserver ─────────────────────────────────────────────────

  onMainRunStart(e: MainRunStart): void {
    try {
      const cfg = this.d.config();
      // `practice` and `count` both observe main verifies: a main verify never counts a helper's results.
      if (cfg.mode === 'off' || cfg.helpers.length === 0) return;
      if (!this.d.signer) { this.error('start', null, 'no machine signer'); return; }
      let resolveEnded!: (x: MainRunEnd) => void;
      const ended = new Promise<MainRunEnd>((r) => { resolveEnded = r; });
      const ctx: RunCtx = {
        headSha: e.headSha, runToken: e.runToken, runAttemptId: newId(), startedAt: e.startedAt,
        unitEndAt: e.startedAt, abort: new AbortController(), ended, resolveEnded, tasks: [],
      };
      this.runs.set(e.runToken, ctx);
      for (const h of cfg.helpers) {
        ctx.tasks.push(this.runHelper(ctx, h).catch((err) => this.error('task', h.machineId, err)));
      }
      void Promise.allSettled(ctx.tasks).then(() => { this.runs.delete(e.runToken); });
    } catch (err) {
      this.error('start', null, err);
    }
  }

  onMainRunEnd(e: MainRunEnd): void {
    try {
      const ctx = this.runs.get(e.runToken);
      if (!ctx) return;
      // The unit lane is over at the latest now: outstanding work is cancelled and hung requests abandoned.
      ctx.abort.abort();
      ctx.resolveEnded(e);
    } catch (err) {
      this.error('end', null, err);
    }
  }

  info(): unknown {
    const cfg = this.d.config();
    const state = this.store.snapshot();
    return {
      mode: cfg.mode,
      helpers: cfg.helpers.map((h) => ({
        machineId: h.machineId, url: h.url,
        asking: state[h.machineId]?.ask ?? null,
        lastShadow: this.lastSummary.get(h.machineId) ?? null,
        learned: this.lastLearned.get(h.machineId) ?? null,
        countedRuns: (state[h.machineId]?.runs ?? []).filter((r) => r.counted).length,
      })),
    };
  }

  // ── one helper, one run ─────────────────────────────────────────────

  private signed<T extends HelperSliceRequest | HelperCancelRequest | HelperLearnedRequest>(req: T) {
    return signHelperRequest(this.d.signer!, req);
  }

  private async runHelper(ctx: RunCtx, h: HelperTarget): Promise<void> {
    const signal = ctx.abort.signal;
    // One status request with a 2-second limit at the start of the verify; a silent helper is asked less often.
    if (this.asking.decide(h) !== 'ask') return;
    const sent: SentSlice[] = [];
    let transportOk = false;
    let prepMs: number | null = null;
    let prepWaitMs: number | null = null;
    let prepNotReady = false;
    let copyMs: number | null = null;
    let status: HelperStatusView | null = null;
    let verdictsMeta = { scanHitShare: 0, scanHits: 0, scanDeepHits: 0, eligible: 0, neverEligibleShare: 0 };
    let sentAnything = false;

    try {
      // No answer (or one whose signature does not hold) means no helper for this verify.
      status = await this.asking.ask(h, signal);
      if (!status) throw new HelperUnreachable('status');
      transportOk = true;
      // Plan: the head's unit files, the helper's learned list, D's rules.
      const files = await this.d.unitFiles(ctx.headSha);
      const durations = Object.fromEntries(files.map((f) => [f.file, f.ms]));
      const totalMs = files.reduce((n, f) => n + f.ms, 0);
      const projected = Math.round((totalMs / Math.max(1, this.d.localWorkers)) * BORROWED_PLAN.defaultWallFactor);
      ctx.unitEndAt = ctx.startedAt + BORROWED_PLAN.setupAllowanceMs + projected;
      this.lastLearned.set(h.machineId, { entries: status.learned.entries.length, incompatible: status.learned.incompatible, files: status.learned.entries.slice(0, 50).map((e) => e.file) });
      const learned = new Set(status.learned.entries.map((e) => e.file));
      // PROVISIONAL (stage 1 of the amendment): the main-verify observer still sends the unit lane only.
      const verdicts = await judgeEligibility(files.map((f) => f.file), 'unit', this.d.treeReader(ctx.headSha), learned);
      let hits = 0;
      let deep = 0;
      for (const v of verdicts) {
        deep += v.deepHits.length;
        for (const hit of v.hits) {
          hits++;
          const key = `${hit.file}|${hit.matchedFile}|${hit.line}|${hit.pattern}`;
          if (!this.seenScanHits.has(key)) { this.seenScanHits.add(key); this.audit({ event: 'scan-hit', ...hit }); }
        }
      }
      const eligible = verdicts.filter((v) => v.eligible).map((v) => ({ file: v.file, ms: durations[v.file] ?? 0 }));
      verdictsMeta = { scanHitShare: scanHitShare(verdicts, durations), scanHits: hits, scanDeepHits: deep, eligible: eligible.length, neverEligibleShare: 0 };

      // Prepare first, then poll every 5 s until the tree is ready; stop waiting at unit-lane end.
      const prepReq: HelperSliceRequest = { kind: 'slice', attemptId: newId(), runAttemptId: ctx.runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: h.machineId, lane: 'unit', baseSha: ctx.headSha, headSha: ctx.headSha, files: [], deadlineAt: ctx.unitEndAt, budgetMs: 1, expiresAt: this.now() + HELPER_LIMITS.requestMaxLifetimeMs, prepare: true };
      const prepStart = this.now();
      const pr = await this.d.client.slice(h, this.signed(prepReq), 30_000, signal);
      sentAnything = true;
      if (!pr) { transportOk = false; throw new HelperUnreachable('prepare'); }
      const prepAns = parseHelperAnswer(pr.body);
      if (!prepAns || prepAns.state !== 'preparing') {
        sent.push({ request: prepReq, canary: false, answer: prepAns, sigRefusal: null, refusedReason: String((pr.body as { reason?: unknown } | null)?.reason ?? prepAns?.state ?? `http-${pr.status}`) });
      } else {
        const sig = verifyHelperAnswer(prepAns, h.machineId, this.d.keyLookup(), this.now());
        if (sig) sent.push({ request: prepReq, canary: false, answer: prepAns, sigRefusal: sig });
        let ready = false;
        while (!signal.aborted && this.now() < ctx.unitEndAt) {
          const st = await this.d.client.status(h, signal);
          if (st) status = st;
          const t = st?.trees.find((x) => x.headSha === ctx.headSha);
          if (t?.state === 'ready') { ready = true; prepMs = t.prepMs; copyMs = t.copyMs ?? null; break; }
          if (t?.state === 'failed') { sent.push({ request: prepReq, canary: false, answer: null, sigRefusal: null, refusedReason: t.reason ?? 'prep-failed' }); break; }
          await this.sleep(HELPER_LIMITS.statusPollMs, signal);
        }
        prepWaitMs = this.now() - prepStart;
        if (!ready && !sent.some((s) => s.refusedReason)) prepNotReady = true;
        if (ready) await this.sendSlices(ctx, h, status!, eligible, verdictsMeta, sent);
      }
    } catch (e) {
      if (!(e instanceof HelperUnreachable)) this.error('run', h.machineId, e);
    } finally {
      if (sentAnything) {
        try {
          const c: HelperCancelRequest = { kind: 'cancel', attemptId: newId(), runAttemptId: ctx.runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: h.machineId, expiresAt: this.now() + HELPER_LIMITS.requestMaxLifetimeMs };
          await this.d.client.cancel(h, this.signed(c));
        } catch (e) { this.error('cancel', h.machineId, e); }
      }
    }

    // Compare only after the run's record is written.
    let end: MainRunEnd;
    try { end = await ctx.ended; } catch (e) { this.error('await-end', h.machineId, e); return; }
    try {
      const local = end.recorded ? await this.d.localUnitReport(ctx.headSha) : null;
      // The dry run counts only on a tree this machine verified green.
      const dryRun = this.d.config().dryRun === true;
      const cmp = compareShadow(sent, local, BORROWED_CANARY, { source: dryRun && end.outcome === 'success' ? 'dry-run' : 'paired' });
      if (dryRun && end.outcome === 'success') {
        const covered = this.dryRunCovered.get(h.machineId) ?? new Set<string>();
        for (const s of sent) if (!s.canary && s.answer?.state === 'done') for (const f of s.request.files) covered.add(f);
        this.dryRunCovered.set(h.machineId, covered);
      }
      const goodAnswer = sent.some((s) => s.answer && !s.sigRefusal);
      const outcome: 'good' | 'bad' = !transportOk || cmp.badSignatures > 0 || (sent.length > 0 && !goodAnswer && !sent.some((s) => s.refusedReason)) ? 'bad' : 'good';
      if (end.recorded && cmp.observations.length > 0 && local && !(dryRun && end.outcome !== 'success')) {
        try {
          // PROVISIONAL (stage 5: the run machine's own merge-tree hash): the tree the helper says it ran.
          // One comparison per file per request (the last one found stands).
          const treeHash = sent.map((s) => s.answer?.treeHash).find((t): t is string => typeof t === 'string');
          const byFile = new Map(cmp.observations.map((o) => [o.file, o]));
          if (treeHash) {
            const l: HelperLearnedRequest = { kind: 'learned', attemptId: newId(), runAttemptId: ctx.runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: h.machineId, treeHash, expiresAt: this.now() + HELPER_LIMITS.requestMaxLifetimeMs, observations: [...byFile.values()].slice(0, HELPER_LIMITS.maxFilesPerRequest) };
            await this.d.client.learned(h, this.signed(l));
          }
        } catch (e) { this.error('learned', h.machineId, e); }
      }
      const vs = cmp.vitestStartMs;
      const b = this.budgets.get(h.machineId) ?? { budgetMs: BORROWED_PLAN.initialBudgetMs, vitestStarts: [] };
      b.vitestStarts = [...b.vitestStarts, ...vs].slice(-20);
      b.budgetMs = nextBudgetMs(b.budgetMs, b.vitestStarts);
      this.budgets.set(h.machineId, b);
      const counted = cmp.done > 0;
      this.store.addRun(h.machineId, { at: this.now(), counted, slicesSent: cmp.slicesSent, done: cmp.done, agree: cmp.agree, disagree: cmp.disagree.length, helperMs: cmp.helperMs, localMs: cmp.localMs, prepMs, vitestStartMs: vs.length ? vs[Math.floor(vs.length / 2)] : null });
      try { this.store.save(); } catch (e) { this.error('state', h.machineId, e); }
      const row = {
        event: 'borrowed-shadow',
        helper: h.machineId, headSha: ctx.headSha, runAttemptId: ctx.runAttemptId, recorded: end.recorded, compared: end.recorded && local !== null,
        slicesSent: cmp.slicesSent, done: cmp.done, handedBack: cmp.handedBack, busy: cmp.busy, ownerBusy: cmp.ownerBusy,
        refused: cmp.refused, invalidAnswers: cmp.invalidAnswers, agree: cmp.agree, uncollected: cmp.uncollected,
        disagree: { files: cmp.disagree.slice(0, 50), total: cmp.disagree.length }, sliceErrors: cmp.sliceErrors,
        resultOversize: cmp.resultOversize, localRedCompared: cmp.localRedCompared, localMissing: cmp.localMissing,
        canary: cmp.canary,
        helperSec: Math.round(cmp.helperMs / 100) / 10, localSec: Math.round(cmp.localMs / 100) / 10,
        prepMs, prepWaitMs, prepNotReady, copyMs, handBackMs: cmp.handBackMs, ownerCoresMax: cmp.ownerCoresMax,
        vitestStartMs: vs, sandboxStartMs: status?.sandbox?.startMs ?? null, sandboxPeakMemMb: status?.sandbox?.peakMemMb ?? null,
        ...(dryRun ? { dryRun: true, dryRunCovered: this.dryRunCovered.get(h.machineId)?.size ?? 0 } : {}),
        neverEligibleShare: verdictsMeta.neverEligibleShare, scanHitShare: verdictsMeta.scanHitShare,
        scanHits: verdictsMeta.scanHits, scanDeepHits: verdictsMeta.scanDeepHits, eligibleFiles: verdictsMeta.eligible,
        learnedEntries: status?.learned.entries.length ?? null, incompatible: status?.learned.incompatible ?? null,
        helperVersion: status?.helperVersion ?? null, runVersion: this.d.version, helperOutcome: outcome,
      };
      this.lastSummary.set(h.machineId, { at: new Date(this.now()).toISOString(), ...row });
      this.audit(row);
    } catch (e) {
      this.error('compare', h.machineId, e);
    }
  }

  private async sendSlices(ctx: RunCtx, h: HelperTarget, status: HelperStatusView, eligible: Array<{ file: string; ms: number }>, meta: { neverEligibleShare: number }, sent: SentSlice[]): Promise<void> {
    const signal = ctx.abort.signal;
    const st = this.store.get(h.machineId);
    const throughput = measuredThroughput(st.runs) ?? seededThroughput(this.d.localWorkers);
    const prepP90 = measuredPrepP90(st.runs) ?? BORROWED_PLAN.seedPrepMs;
    const totalMs = eligible.reduce((n, f) => n + f.ms, 0);
    // A helper refuses a slice whose stated budget is above its lane's (10 s for unit).
    const budgetMs = Math.min(this.budgets.get(h.machineId)?.budgetMs ?? BORROWED_PLAN.initialBudgetMs, HELPER_LIMITS.sliceBudgetMs.unit);
    const dryRun = this.d.config().dryRun === true;
    // The dry run sends every eligible file (files not yet covered first) until the unit lane ends.
    const covered = this.dryRunCovered.get(h.machineId) ?? new Set<string>();
    const ordered = dryRun ? [...eligible.filter((f) => !covered.has(f.file)), ...eligible.filter((f) => covered.has(f.file))] : eligible;
    const amount = dryRun ? Number.POSITIVE_INFINITY : sendAmountMs({ throughput, projectedUnitMs: Math.max(0, ctx.unitEndAt - ctx.startedAt - BORROWED_PLAN.setupAllowanceMs), prepP90Ms: prepP90 });
    const plan = dryRun ? planDryRun(ordered, budgetMs, throughput) : planSlices({ files: ordered, budgetMs, throughput, sendLocalMs: amount });
    meta.neverEligibleShare = totalMs > 0 ? Math.round((plan.neverEligibleMs / totalMs) * 1000) / 1000 : 0;
    const queue: Array<{ files: string[]; canary: boolean; retrial: boolean }> = plan.slices.map((files) => ({ files, canary: false, retrial: false }));
    // Re-trial: learned files that are due (version, content or every 10th run), at most 5, in their own slice.
    const due = status.learned.entries.filter((e) => e.retrialDue).map((e) => e.file).slice(0, HELPER_LIMITS.retrialMaxFiles);
    if (due.length > 0) queue.unshift({ files: due, canary: false, retrial: true });
    // The canary slice, at a random position: the helper is not told which slice it is.
    const pos = Math.floor((this.d.random ?? Math.random)() * (queue.length + 1));
    queue.splice(pos, 0, { files: [...BORROWED_CANARY_FILES], canary: true, retrial: false });
    let resultSeq = 0;
    for (const q of queue) {
      if (signal.aborted || this.now() >= ctx.unitEndAt) break;
      const deadlineAt = Math.min(ctx.unitEndAt, this.now() + budgetMs * BORROWED_PLAN.longFileFactor + 30_000);
      const req: HelperSliceRequest = {
        kind: 'slice', attemptId: newId(), runAttemptId: ctx.runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: h.machineId,
        // A main verify: the base and the head are the same merged commit. Everything is compared, nothing used.
        lane: 'unit', baseSha: ctx.headSha, headSha: ctx.headSha, use: q.canary ? 'check' : 'compare',
        files: q.files, deadlineAt, budgetMs, expiresAt: this.now() + HELPER_LIMITS.requestMaxLifetimeMs, ...(q.retrial ? { retrial: true as const } : {}),
      };
      // A helper queues a slice and answers at once; the slice's last signed answer comes through its status.
      const r = await this.d.client.slice(h, this.signed(req), 15_000, signal);
      if (!r) { sent.push({ request: req, canary: q.canary, answer: null, sigRefusal: null }); if (signal.aborted) break; continue; }
      let ans = parseHelperAnswer(r.body);
      if (ans && ans.state === 'queued') {
        // PROVISIONAL (stage 5: the lane flow sends its slices at once and reads results as they come):
        // this observer still sends one slice, waits for its answer, then sends the next.
        ans = null;
        const waitUntil = deadlineAt + 15_000;
        while (!signal.aborted && this.now() < waitUntil) {
          const st = await this.d.client.status(h, signal, { run: ctx.runAttemptId, since: resultSeq });
          const hit = st?.results.map((x) => ({ seq: x.seq, a: parseHelperAnswer(x.answer) })).find((x) => x.a?.attemptId === req.attemptId);
          if (hit?.a) { ans = hit.a; resultSeq = hit.seq; break; }
          await this.sleep(1_000, signal);
        }
        if (!ans) { sent.push({ request: req, canary: q.canary, answer: null, sigRefusal: null }); if (signal.aborted) break; continue; }
      }
      if (!ans) {
        const reason = (r.body as { reason?: unknown } | null)?.reason;
        sent.push({ request: req, canary: q.canary, answer: null, sigRefusal: null, ...(typeof reason === 'string' ? { refusedReason: reason } : {}) });
        if (reason === 'not-prepared' || reason === 'paused' || reason === 'helper-containment-unproven') break;
        continue;
      }
      sent.push({ request: req, canary: q.canary, answer: ans, sigRefusal: verifyHelperAnswer(ans, h.machineId, this.d.keyLookup(), this.now()) });
      if (ans.state === 'owner-busy') break;
      if (ans.state === 'busy') await this.sleep(2_000, signal);
    }
  }
}

class HelperUnreachable extends Error {}

/** Dry-run slices keep the given order (uncovered files first) instead of longest-first packing. */
function planDryRun(files: Array<{ file: string; ms: number }>, budgetMs: number, throughput: number): ReturnType<typeof planSlices> {
  const out = planSlices({ files: [], budgetMs, throughput, sendLocalMs: 0 });
  const cap = Math.max(1, budgetMs * throughput);
  let cur: string[] = [];
  let curMs = 0;
  for (const f of files) {
    if (f.ms > cap * BORROWED_PLAN.longFileFactor) { out.neverEligibleMs += f.ms; out.neverEligibleFiles.push(f.file); continue; }
    if (cur.length > 0 && curMs + f.ms > cap) { out.slices.push(cur); cur = []; curMs = 0; }
    cur.push(f.file);
    curMs += f.ms;
    out.sentLocalMs += f.ms;
  }
  if (cur.length) out.slices.push(cur);
  return out;
}
