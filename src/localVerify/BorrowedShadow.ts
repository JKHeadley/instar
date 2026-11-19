/**
 * The run machine's side of borrowed helpers, SHADOW ONLY (docs/specs/local-verify-borrowed-unit-slices.md, F).
 *
 * With `monitoring.localVerify.borrowed.mode: 'shadow'`, each of this machine's own `main` verifies
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
 */
import crypto from 'node:crypto';
import type { MachineKeyLookup, MachineSigner } from '../core/AppRecordSignatures.js';
import type { FileCounts } from './laneReport.js';
import type { MainRunEnd, MainRunObserver, MainRunStart } from './mainRunObserver.js';
import { judgeEligibility, scanIneligibleShare, type TreeReader } from './borrowedEligibility.js';
import { BORROWED_CANARY, BORROWED_CANARY_FILES } from './borrowedCanary.js';
import { BORROWED_PLAN, nextBudgetMs, planSlices, sendAmountMs, seededThroughput } from './borrowedPlan.js';
import { compareShadow, type SentSlice } from './borrowedCompare.js';
import { BorrowedHelpersStore, helperSkipped, measuredPrepP90, measuredThroughput, noteHelperOutcome } from './borrowedState.js';
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
  private readonly store: BorrowedHelpersStore;
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
    this.store = new BorrowedHelpersStore(d.stateDir);
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
      if (cfg.mode !== 'shadow' || cfg.helpers.length === 0) return;
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
        breaker: state[h.machineId]?.breaker ?? null,
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
    const state = this.store.get(h.machineId);
    if (helperSkipped(state.breaker, this.now())) return;
    const signal = ctx.abort.signal;
    const sent: SentSlice[] = [];
    let transportOk = false;
    let prepMs: number | null = null;
    let prepWaitMs: number | null = null;
    let prepNotReady = false;
    let copyMs: number | null = null;
    let status: HelperStatusView | null = null;
    let verdictsMeta = { scanIneligibleShare: 0, scanHits: 0, scanDeepHits: 0, eligible: 0, neverEligibleShare: 0 };
    let sentAnything = false;

    try {
      // Plan: the head's unit files, the helper's learned list, D's rules.
      const files = await this.d.unitFiles(ctx.headSha);
      const durations = Object.fromEntries(files.map((f) => [f.file, f.ms]));
      const totalMs = files.reduce((n, f) => n + f.ms, 0);
      const projected = Math.round((totalMs / Math.max(1, this.d.localWorkers)) * BORROWED_PLAN.defaultWallFactor);
      ctx.unitEndAt = ctx.startedAt + BORROWED_PLAN.setupAllowanceMs + projected;
      status = await this.d.client.status(h, signal);
      if (!status) throw new HelperUnreachable('status');
      transportOk = true;
      this.lastLearned.set(h.machineId, { entries: status.learned.entries.length, incompatible: status.learned.incompatible, files: status.learned.entries.slice(0, 50).map((e) => e.file) });
      const learned = new Set(status.learned.entries.map((e) => e.file));
      const verdicts = await judgeEligibility(files.map((f) => f.file), this.d.treeReader(ctx.headSha), learned);
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
      verdictsMeta = { scanIneligibleShare: scanIneligibleShare(verdicts, durations), scanHits: hits, scanDeepHits: deep, eligible: eligible.length, neverEligibleShare: 0 };

      // Prepare first, then poll every 5 s until the tree is ready; stop waiting at unit-lane end.
      const prepReq: HelperSliceRequest = { kind: 'slice', attemptId: newId(), runAttemptId: ctx.runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: h.machineId, headSha: ctx.headSha, files: [], deadlineAt: ctx.unitEndAt, budgetMs: 1, expiresAt: this.now() + HELPER_LIMITS.requestMaxLifetimeMs, prepare: true };
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
      const br = noteHelperOutcome(state.breaker, outcome, this.now());
      if (br.reportNow) this.audit({ event: 'helper-unreachable', helper: h.machineId, since: new Date(state.breaker.unreachableSince ?? this.now()).toISOString() });
      if (br.recovered) this.audit({ event: 'helper-reachable', helper: h.machineId });
      if (end.recorded && cmp.observations.length > 0 && local && !(dryRun && end.outcome !== 'success')) {
        try {
          const l: HelperLearnedRequest = { kind: 'learned', attemptId: newId(), runAttemptId: ctx.runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: h.machineId, headSha: ctx.headSha, expiresAt: this.now() + HELPER_LIMITS.requestMaxLifetimeMs, observations: cmp.observations.slice(0, HELPER_LIMITS.maxFilesPerRequest) };
          await this.d.client.learned(h, this.signed(l));
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
        neverEligibleShare: verdictsMeta.neverEligibleShare, scanIneligibleShare: verdictsMeta.scanIneligibleShare,
        scanHits: verdictsMeta.scanHits, scanDeepHits: verdictsMeta.scanDeepHits, eligibleFiles: verdictsMeta.eligible,
        learnedEntries: status?.learned.entries.length ?? null, incompatible: status?.learned.incompatible ?? null,
        helperVersion: status?.helperVersion ?? null, runVersion: this.d.version, breakerOutcome: outcome,
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
    const budgetMs = this.budgets.get(h.machineId)?.budgetMs ?? BORROWED_PLAN.initialBudgetMs;
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
    for (const q of queue) {
      if (signal.aborted || this.now() >= ctx.unitEndAt) break;
      const deadlineAt = Math.min(ctx.unitEndAt, this.now() + budgetMs * BORROWED_PLAN.longFileFactor + 30_000);
      const req: HelperSliceRequest = {
        kind: 'slice', attemptId: newId(), runAttemptId: ctx.runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: h.machineId, headSha: ctx.headSha,
        files: q.files, deadlineAt, budgetMs, expiresAt: this.now() + HELPER_LIMITS.requestMaxLifetimeMs, ...(q.retrial ? { retrial: true as const } : {}),
      };
      const r = await this.d.client.slice(h, this.signed(req), Math.max(5_000, deadlineAt - this.now() + 15_000), signal);
      if (!r) { sent.push({ request: req, canary: q.canary, answer: null, sigRefusal: null }); if (signal.aborted) break; continue; }
      const ans = parseHelperAnswer(r.body);
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
