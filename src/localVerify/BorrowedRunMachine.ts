/**
 * The run machine's server side of borrowed helpers (docs/specs/local-verify-borrowed-slices-count.md,
 * F and "Build decisions"). It holds:
 *
 *  - the practice record (borrowedState.ts, rules in borrowedPractice.ts) and the recorded decision
 *    to count (`POST /local-verify/borrowed/decision`);
 *  - the asking rate and the helper's "I am here" (`POST /local-verify/helper-here`);
 *  - the one-in-ten compare-only assignment, drawn before the helper is asked;
 *  - the loopback proxy the verify's child calls (`POST /local-verify/borrowed-proxy`): the child
 *    holds no key, so this server signs, forwards, checks the answer's signature and returns it;
 *  - the baseline results file (mainFileCounts.ts) and its transfer to peers;
 *  - helper events and who is told (borrowedNotices.ts);
 *  - a recorded dry-run request (`POST /local-verify/borrowed/dry-run`), which the dry-run task
 *    (borrowedDryRun.ts) consumes on the next tick.
 *
 * LocalVerifyService knows this class only through the type `BorrowedRunSeam` and calls it inside
 * try/catch; nothing here is awaited by a verify. With the setting absent every method is inert.
 *
 * The verify's lane flow (borrowedLaneFlow.ts, in the verify child) calls the proxy; its result
 * reaches this class after the record is written (`onVerifyResult`), and only this class updates
 * the practice record.
 */
import crypto from 'node:crypto';
import type { MachineKeyLookup, MachineSigner } from '../core/AppRecordSignatures.js';
import type {
  BorrowedChildFacts, BorrowedGreenMain, BorrowedHttpAnswer, BorrowedMainRed, BorrowedPeerStatusExtras, BorrowedRouteFacts, BorrowedRunSeam, BorrowedVerifyEnd, BorrowedVerifyResult, BorrowedVerifyStart,
} from './mainRunObserver.js';
import { drawAssignment, type BorrowedAssignment } from './borrowedAsk.js';
import { HelperAsking } from './borrowedAsking.js';
import { statusImageIdentity, type HelperClient, type HelperStatusView } from './borrowedClient.js';
import { laneOfTestFile, isBorrowedCanaryFile } from './borrowedEligibility.js';
import { HELPER_EVENT_LIMITS, eventText, newEventId, parseHelperEvents, untold, whoIsTold, type HelperEvent } from './borrowedNotices.js';
import {
  PRACTICE_LANES, applyVerifyOutcome, evidenceProgress, laneProven, mayCount, noteIdentity, noteSpotVerify, noteTime, recordDecision, recordDryRun, spotRateOneIn,
  coverageComplete, spreadComplete, failingDirectionComplete, checkSliceComplete, wrongPassWindowClear,
  type LaneEvent, type LaneRecord, type LaneVerifyOutcome, type PracticeLane, type Transition,
} from './borrowedPractice.js';
import { measuredPrepP90, measuredThroughput, type BorrowedPracticeStore, type HelperRunSummary } from './borrowedState.js';
import { BORROWED_PLAN } from './borrowedPlan.js';
import { MAIN_FILE_COUNTS_LIMITS, parseFileCounts, parseMainFileCounts, type MainFileCountsStore } from './mainFileCounts.js';
import type { BorrowedConfig, HelperTarget } from './helper/helperConfig.js';
import type { BorrowedFlowResult } from './borrowedLaneFlow.js';
import { BorrowedDryRun } from './borrowedDryRun.js';
import {
  HELPER_ID_RE, HELPER_LIMITS, isRequestFile, parseHelperAnswer, parseHelperHere, signHelperRequest, verifyHelperAnswer, verifyHelperHere, verifyHelperStatus,
  type HelperCancelRequest, type HelperLane, type HelperLearnedRequest, type HelperSliceRequest, type HelperSliceUse, type LearnedObservation,
} from './helper/helperProtocol.js';

export const BORROWED_PROXY = Object.freeze({
  /** The header that carries the verify's attempt token. */
  tokenHeader: 'x-instar-attempt-token',
  /** Each call has this limit; past it the answer is "no helper answer". */
  callTimeoutMs: 5_000,
  /** The latest deadline a slice may state, counted from now (the longest lane deadline). */
  maxDeadlineInMs: 60 * 60_000,
  /** A baseline is offered again to a peer that has not acknowledged it at most this often… */
  baselineRetryMs: 5 * 60_000,
  /** …and at most this many times per version (the next green `main` offers a new one). */
  baselineMaxTries: 5,
  /** A verify's helper session is kept this long after its child ended, for its result (then the helper is told the verify is over). */
  endedKeepMs: 15 * 60_000,
  /** The failing-direction request (after the record) waits at most this long for the helper's answers. */
  failingDirectionMs: 10 * 60_000,
  failingDirectionPollMs: 5_000,
  /** A lane's helper share: after this many verifies in which it was sent work, it follows the finish rate. */
  shareMeasuredAfter: 5,
  shareMin: 0.05,
  /** A helper a peer reported is still accepted on its records for this long after it stops being reported. */
  peerHelperMemoryMs: 24 * 60 * 60_000,
  /** A red `main` a peer did not take is sent once more after this long. */
  mainRedRetryMs: 60_000,
});

const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const MACHINE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * Why the loopback proxy refuses a request before looking at it: it arrived through the tunnel
 * (the connector reaches the server on loopback, so the header is what tells), through any other
 * forwarder, or on a socket that is not loopback. Unknown is refused. Pure.
 */
export function proxyRouteRefusal(f: BorrowedRouteFacts): 'tunnel' | 'forwarded' | 'not-loopback' | null {
  const present = (v: string | string[] | undefined): boolean => v !== undefined && !(typeof v === 'string' && v === '') && !(Array.isArray(v) && v.length === 0);
  if (present(f.cfConnectingIp)) return 'tunnel';
  if (present(f.forwardedFor)) return 'forwarded';
  if (typeof f.remoteAddress !== 'string' || !LOOPBACK.test(f.remoteAddress)) return 'not-loopback';
  return null;
}

/** What a verify's child may ask through the proxy. The commits, the helper and the ids are never among it. */
export type ProxyOp =
  | { op: 'plan' }
  | { op: 'status'; since?: number }
  | { op: 'prepare'; lane: HelperLane; deadlineInMs: number }
  | { op: 'slice'; lane: HelperLane; files: string[]; use: HelperSliceUse; budgetMs: number; deadlineInMs: number; retrial?: true }
  | { op: 'cancel'; attemptIds?: string[]; verifyOver?: true };

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const isLane = (v: unknown): v is HelperLane => (PRACTICE_LANES as readonly unknown[]).includes(v);
const only = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));

/**
 * Parse a proxy request body, strictly: exactly the fields of one operation. A body that names a
 * commit, a helper, an address, a requester or an id of its own (any unknown field) is malformed,
 * so nothing the caller names in their place is ever read. File lists are accepted only as
 * bounded lists of distinct test-file paths of the stated lane. Pure.
 */
export function parseProxyOp(body: unknown): ProxyOp | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  switch (b.op) {
    case 'plan':
      return only(b, ['op']) ? { op: 'plan' } : null;
    case 'status':
      if (!only(b, ['op', 'since'])) return null;
      if (b.since !== undefined && !isInt(b.since, 0, Number.MAX_SAFE_INTEGER)) return null;
      return { op: 'status', ...(b.since !== undefined ? { since: b.since as number } : {}) };
    case 'prepare':
      if (!only(b, ['op', 'lane', 'deadlineInMs']) || !isLane(b.lane) || !isInt(b.deadlineInMs, 1_000, BORROWED_PROXY.maxDeadlineInMs)) return null;
      return { op: 'prepare', lane: b.lane, deadlineInMs: b.deadlineInMs };
    case 'slice': {
      if (!only(b, ['op', 'lane', 'files', 'use', 'budgetMs', 'deadlineInMs', 'retrial']) || !isLane(b.lane)) return null;
      if (b.use !== 'check' && b.use !== 'count' && b.use !== 'compare') return null;
      if (!isInt(b.budgetMs, 1, HELPER_LIMITS.sliceBudgetMs[b.lane]) || !isInt(b.deadlineInMs, 1_000, BORROWED_PROXY.maxDeadlineInMs)) return null;
      if (b.retrial !== undefined && b.retrial !== true) return null;
      const files = b.files;
      if (!Array.isArray(files) || files.length < 1 || files.length > HELPER_LIMITS.maxFilesPerRequest || !files.every(isRequestFile)) return null;
      if (new Set(files as string[]).size !== files.length) return null;
      // A check slice holds the fixture files only; every other slice only real test files of the stated lane.
      const lane = b.lane;
      const fits = b.use === 'check'
        ? (files as string[]).every((f) => isBorrowedCanaryFile(f))
        : (files as string[]).every((f) => !isBorrowedCanaryFile(f) && laneOfTestFile(f) === lane);
      if (!fits) return null;
      if (b.retrial === true && (b.use !== 'compare' || files.length > HELPER_LIMITS.retrialMaxFiles)) return null;
      return { op: 'slice', lane, files: [...(files as string[])], use: b.use, budgetMs: b.budgetMs, deadlineInMs: b.deadlineInMs, ...(b.retrial === true ? { retrial: true as const } : {}) };
    }
    case 'cancel': {
      if (!only(b, ['op', 'attemptIds', 'verifyOver'])) return null;
      if (b.verifyOver !== undefined && b.verifyOver !== true) return null;
      if (b.attemptIds !== undefined) {
        if (b.verifyOver !== undefined) return null;
        const ids = b.attemptIds;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > HELPER_LIMITS.maxCancelAttemptIds || !ids.every((i) => typeof i === 'string' && HELPER_ID_RE.test(i))) return null;
        return { op: 'cancel', attemptIds: [...(ids as string[])] };
      }
      return { op: 'cancel', ...(b.verifyOver === true ? { verifyOver: true as const } : {}) };
    }
    default:
      return null;
  }
}

/**
 * A lane's helper share (spec "Which lanes, and how much"): a quarter of its time until the helper
 * has been sent work in 5 verifies, then half its measured finish rate (the files it finished over
 * the files it was sent, over its last 10 such verifies), never below 5 % or above half. Pure.
 */
export function laneShareFromRuns(runs: readonly HelperRunSummary[]): number {
  const sent = runs.filter((r) => r.slicesSent > 0).slice(-10);
  if (sent.length < BORROWED_PROXY.shareMeasuredAfter) return 0.25;
  const rate = sent.reduce((n, r) => n + Math.min(1, r.done / r.slicesSent), 0) / sent.length;
  return Math.min(0.5, Math.max(BORROWED_PROXY.shareMin, 0.5 * rate));
}

export interface BorrowedRunMachineDeps {
  config: () => BorrowedConfig;
  store: BorrowedPracticeStore;
  baseline: MainFileCountsStore;
  client: HelperClient;
  signer: MachineSigner | null;
  keyLookup: () => MachineKeyLookup;
  machineId: string;
  /** True when this machine is the coordinator (holds the serving lease, or has no pool). Only the coordinator sends notices and keeps baselines. */
  isCoordinator: () => boolean;
  /** Coordinator: send a red `main` to one peer (`POST /local-verify/peer-main-red`); true when the peer took it. */
  postPeerMainRed?: (peer: { machineId: string; url: string }, body: unknown) => Promise<boolean>;
  /** Coordinator: send the baseline file to one peer (`POST /local-verify/peer-baseline`); true when the peer stored it. */
  postPeerBaseline?: (peer: { machineId: string; url: string }, body: unknown) => Promise<boolean>;
  audit(event: Record<string, unknown>): void;
  /** The existing attention seam. `line`: the session that operates the line. `owner`: the owner's topic for that machine. */
  notify?: (who: 'line' | 'owner', event: HelperEvent, text: string, ownerReason: string | null) => void;
  /** This server's port (the verify child reaches the proxy on loopback). Absent: no verify is offered a helper. */
  port?: number;
  /** Whether `ancestor` is `descendant` or an ancestor of it (the "pass made main red" rule). Null: could not tell. */
  isAncestor?: (ancestor: string, descendant: string) => Promise<boolean | null>;
  /** Wait (the failing-direction request polls the helper). */
  sleep?: (ms: number) => Promise<void>;
  /** The commit's test files with this machine's recorded times (the dry run reads the verify clone). Absent: no dry run starts. */
  treeFiles?: (commit: string) => Promise<Array<{ file: string; ms: number | null }>>;
  /** One row in the maturation ladder's evidence log (logs/feature-evidence.jsonl). */
  evidence?: (row: { kind: 'fired' | 'held'; reason: string; subject: string; context: Record<string, string | number | boolean | null> }) => void;
  now?: () => number;
  /** A whole number in [0, n) from a cryptographic source. */
  randomInt?: (n: number) => number;
}

interface VerifyCtx {
  token: string;
  kind: 'main' | 'waiting';
  pr: number;
  baseSha: string;
  headSha: string;
  /** This server's id for the verify's helper work; the child never names one. */
  runAttemptId: string;
  helper: HelperTarget | null;
  assigned: BorrowedAssignment | null;
  /** Resolves true when the helper answered this verify's one status request. */
  asked: Promise<boolean>;
  /** The helper's answer to that request (its learned list, its free workers). */
  status: HelperStatusView | null;
  /** Slices this server issued for the verify (a cancel may name only these), with what each named. */
  issued: Map<string, { lane: HelperLane; files: string[]; use: HelperSliceUse }>;
  abort: AbortController;
  /** Set when the child ended: the proxy no longer answers it; the session waits for the result. */
  endedAt: number | null;
}

export class BorrowedRunMachine implements BorrowedRunSeam {
  private readonly now: () => number;
  private readonly asking: HelperAsking;
  private readonly verifies = new Map<string, VerifyCtx>();
  /** Coordinator: what each peer last reported (its helpers, whether it wants the baseline, its events). */
  private readonly peerSeen = new Map<string, { url: string; wantsBaseline: boolean; helpers: string[]; events: HelperEvent[] }>();
  /** Coordinator: each peer's helpers with when they were last reported. */
  private readonly peerHelpersEver = new Map<string, Map<string, number>>();
  /** Coordinator: the baseline hash each peer acknowledged, and the hash last offered with its time (a refused offer is repeated at most every 5 minutes). */
  private readonly peerBaseline = new Map<string, { hash: string | null; triedHash: string | null; triedAt: number; tries: number }>();

  private readonly dryRunTask: BorrowedDryRun | null;

  constructor(private readonly d: BorrowedRunMachineDeps) {
    this.now = d.now ?? (() => Date.now());
    const sleep = (ms: number, signal?: AbortSignal) => (d.sleep ? d.sleep(ms) : new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    }));
    this.dryRunTask = d.treeFiles ? new BorrowedDryRun({
      client: d.client, signer: d.signer, keyLookup: d.keyLookup, machineId: d.machineId, store: d.store, baseline: d.baseline,
      treeFiles: d.treeFiles, recordDryRunResult: (h, lane, r) => this.recordDryRunResult(h, lane, r),
      audit: (e) => this.audit(e), ...(d.evidence ? { evidence: d.evidence } : {}), now: this.now, sleep,
    }) : null;
    this.asking = new HelperAsking({
      store: d.store, client: d.client, keyLookup: d.keyLookup, audit: (e) => this.audit(e), now: this.now,
      onStatus: (h, st) => this.onHelperStatus(h, st),
    });
  }

  /** The shared asking bookkeeping (the main-verify observer uses the same one). */
  helperAsking(): HelperAsking { return this.asking; }

  private audit(e: Record<string, unknown>): void {
    try { this.d.audit(e); } catch { /* @silent-fallback-ok: the audit log never breaks a verify */ }
  }

  private cfg(): BorrowedConfig {
    try { return this.d.config(); } catch { return { mode: 'off', helpers: [] }; } // @silent-fallback-ok: an unreadable setting is off
  }

  private save(): void {
    try { this.d.store.save(); } catch (e) { this.audit({ event: 'borrowed-state-unwritable', detail: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  }

  private coordinator(): boolean {
    try { return this.d.isCoordinator() === true; } catch { return false; } // @silent-fallback-ok: an unreadable lease reads as not the coordinator (no notice is sent twice)
  }

  // ── practice record ─────────────────────────────────────────────────

  /** Apply a lane transition: store it, record its events, tell who must be told. */
  private applyTransition(helper: string, lane: PracticeLane, t: Transition): void {
    this.d.store.setLane(helper, lane, t.lane);
    for (const ev of t.events) this.recordLaneEvent(helper, lane, ev);
  }

  private recordLaneEvent(helper: string, lane: PracticeLane, ev: LaneEvent): void {
    if (ev.kind === 'resumed' || ev.kind === 'identity-reset') { this.audit({ event: `borrowed-${ev.kind}`, helper, lane, ...(ev.kind === 'identity-reset' ? { reason: ev.reason } : {}) }); return; }
    const e: HelperEvent = {
      id: newEventId(), at: this.now(), runMachineId: this.d.machineId, helper, lane, kind: ev.kind,
      ...(ev.kind === 'lapse' ? { reason: ev.reason, fault: ev.fault } : {}),
      ...(ev.kind === 'wrong-pass' ? { file: ev.file, ...(ev.change !== null && /^[0-9]{1,10}$/.test(ev.change) ? { change: ev.change } : {}) } : {}),
    };
    this.d.store.addEvent(e);
    this.audit({ event: 'borrowed-helper-event', ...e, at: new Date(e.at).toISOString() });
    if (this.coordinator()) this.tell(e, this.d.store.events());
  }

  /** One notice, once: the audit row, the line's session, and the owner only in the two stated cases. */
  private tell(e: HelperEvent, history: readonly HelperEvent[]): void {
    /* @self-action-controller: local-verify-borrowed-helper-notice */
    const w = whoIsTold(e, history);
    this.audit({ event: 'borrowed-notice', id: e.id, helper: e.helper, lane: e.lane, kind: e.kind, line: w.line, owner: w.owner, ...(w.ownerReason ? { ownerReason: w.ownerReason } : {}) });
    const text = eventText(e);
    try {
      if (w.line) this.d.notify?.('line', e, text, null);
      if (w.owner) this.d.notify?.('owner', e, text, w.ownerReason);
    } catch (err) { this.audit({ event: 'borrowed-seam-error', step: 'notify', detail: String(err instanceof Error ? err.message : err).slice(0, 200) }); }
    this.d.store.markTold([e.id]);
  }

  /**
   * What one verify showed, per lane (the lane flow and the main-verify observer report it; the
   * server alone updates the practice record). The spot re-run rate moves once per verify.
   */
  recordVerify(helper: string, outcomes: Partial<Record<PracticeLane, LaneVerifyOutcome>>): void {
    // The mass rule counts the whole verify's disagreements, so every lane sees the verify's total.
    let total = 0;
    for (const lane of PRACTICE_LANES) { const o = outcomes[lane]; if (o) total += o.digestDiffersBothPass.length + o.helperFailedLocalPassed.length + o.confirmedWrongPasses.length; }
    let disagreed = false;
    let served = false;
    for (const lane of PRACTICE_LANES) {
      const o = outcomes[lane];
      if (!o) continue;
      const t = applyVerifyOutcome(this.d.store.lane(helper, lane, this.now()), { ...o, verifyDisagreements: total }, this.now());
      this.applyTransition(helper, lane, t);
      disagreed = disagreed || t.disagreed;
      served = served || o.finished > 0;
    }
    if (served) { const h = this.d.store.get(helper); h.spot = noteSpotVerify(h.spot, disagreed); }
    this.save();
  }

  /** The dry run's result for a lane (the dry-run task calls it). */
  recordDryRunResult(helper: string, lane: PracticeLane, r: { eligible: readonly string[]; compared: readonly string[]; eligibleDigest: string; proven?: boolean }): void {
    this.d.store.setLane(helper, lane, recordDryRun(this.d.store.lane(helper, lane, this.now()), r, this.now()));
    this.save();
  }

  /** A verified status answer: the image and runner version the evidence belongs to. */
  private onHelperStatus(h: HelperTarget, st: HelperStatusView): void {
    const image = statusImageIdentity(st);
    if (!image || typeof st.runnerVersion !== 'string' || st.runnerVersion.length === 0) return;
    for (const lane of PRACTICE_LANES) {
      this.applyTransition(h.machineId, lane, noteIdentity(this.d.store.lane(h.machineId, lane, this.now()), { image, runnerVersion: st.runnerVersion }, this.now()));
    }
  }

  // ── verify start / end ──────────────────────────────────────────────

  onVerifyStart(e: BorrowedVerifyStart): void {
    const cfg = this.cfg();
    if (cfg.mode === 'off' || cfg.helpers.length === 0) return;
    const helper = cfg.helpers[0];
    const ctx: VerifyCtx = {
      token: e.token, kind: e.kind, pr: e.pr, baseSha: e.baseSha, headSha: e.headSha, runAttemptId: crypto.randomBytes(16).toString('hex'),
      helper, assigned: null, asked: Promise.resolve(false), status: null, issued: new Map(), abort: new AbortController(), endedAt: null,
    };
    this.verifies.set(e.token, ctx);
    // A main verify never counts a helper's results; its asking and comparing stay in the detached observer.
    if (e.kind === 'main') return;
    // Drawn BEFORE the helper is asked, so it cannot depend on the answer; recorded now.
    ctx.assigned = drawAssignment(this.d.randomInt);
    this.audit({ event: 'borrowed-assigned', pr: e.pr, headSha: e.headSha, baseSha: e.baseSha, helper: helper.machineId, assigned: ctx.assigned });
    const decision = this.asking.decide(helper);
    if (decision !== 'ask') return;
    ctx.asked = this.asking.ask(helper, ctx.abort.signal).then((st) => { ctx.status = st; return st !== null; }, () => false);
    // Preparation starts when the verify starts (spec E), so the run machine's own set-up minutes are not wasted.
    void ctx.asked.then((ok) => (ok ? this.prepareAtStart(ctx) : undefined)).catch((err) => this.audit({ event: 'borrowed-seam-error', step: 'prepare', detail: String(err instanceof Error ? err.message : err).slice(0, 200) }));
  }

  /** One preparation request for the verify's tree, on the first lane a dry run proved (a helper refuses a waiting change's tree on an unproven lane). */
  private async prepareAtStart(ctx: VerifyCtx): Promise<void> {
    const helper = ctx.helper;
    if (!helper || !this.d.signer || ctx.endedAt !== null) return;
    const lane = PRACTICE_LANES.find((l) => laneProven(this.d.store.peekLane(helper.machineId, l)));
    if (!lane) { this.audit({ event: 'borrowed-prepare-skipped', pr: ctx.pr, helper: helper.machineId, reason: 'no-proven-lane' }); return; }
    const now = this.now();
    const req: HelperSliceRequest = {
      kind: 'slice', attemptId: crypto.randomBytes(16).toString('hex'), runAttemptId: ctx.runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: helper.machineId,
      expiresAt: now + HELPER_LIMITS.requestMaxLifetimeMs, lane, baseSha: ctx.baseSha, headSha: ctx.headSha, files: [], deadlineAt: now + BORROWED_PROXY.maxDeadlineInMs, budgetMs: 1, prepare: true,
    };
    const r = await this.d.client.slice(helper, signHelperRequest(this.d.signer, req), BORROWED_PROXY.callTimeoutMs, ctx.abort.signal);
    const ans = r ? parseHelperAnswer(r.body) : null;
    this.audit({ event: 'borrowed-prepare', pr: ctx.pr, helper: helper.machineId, lane, state: ans?.state ?? (r ? `http-${r.status}` : 'no-answer'), ...(ans?.reason ? { reason: String(ans.reason).slice(0, 60) } : {}) });
  }

  onVerifyEnd(e: BorrowedVerifyEnd): void {
    const ctx = this.verifies.get(e.token);
    if (!ctx) return;
    ctx.abort.abort();
    // A waiting change's session stays until its result arrives (or 15 minutes), so the failing-direction
    // request can use the helper's kept tree; the proxy no longer answers it either way.
    if (ctx.kind === 'main' || !ctx.helper || ctx.endedAt !== null || e.cancelled) { this.verifies.delete(e.token); if (ctx.kind !== 'main' && ctx.helper) void this.tellOver(ctx); return; }
    ctx.endedAt = this.now();
  }

  /** Tell the helper the verify is over (its kept tree may go). Never throws. */
  private async tellOver(ctx: VerifyCtx): Promise<void> {
    const helper = ctx.helper;
    if (!helper || !this.d.signer) return;
    try {
      const req: HelperCancelRequest = { kind: 'cancel', attemptId: crypto.randomBytes(16).toString('hex'), runAttemptId: ctx.runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: helper.machineId, expiresAt: this.now() + HELPER_LIMITS.requestMaxLifetimeMs, verifyOver: true };
      await this.d.client.cancel(helper, signHelperRequest(this.d.signer, req), undefined, BORROWED_PROXY.callTimeoutMs);
    } catch (err) { this.audit({ event: 'borrowed-seam-error', step: 'verify-over', detail: String(err instanceof Error ? err.message : err).slice(0, 200) }); }
  }

  /** The helper named when a verify started (so a setting switched off mid-verify cannot lose that verify's record). */
  helperFor(token: string): string | null {
    return this.verifies.get(token)?.helper?.machineId ?? null;
  }

  /**
   * What the verify child is given (spec F "Where the exchange runs"): this server's port, the
   * verify's own token, and the kept baseline results (hash-checked on read). Null with the setting
   * off, no helper, or no port: the verify then runs exactly as without helpers.
   */
  childInput(token: string): BorrowedChildFacts | null {
    const cfg = this.cfg();
    if (cfg.mode === 'off' || cfg.helpers.length === 0 || typeof this.d.port !== 'number' || !TOKEN_RE.test(token)) return null;
    const r = this.d.baseline.read();
    return { port: this.d.port, token, baselines: r.ok ? r.file.baselines : [] };
  }

  // ── a verify's result (after its record is written) ─────────────────

  /**
   * The lane flow's result for a verify of a waiting change. The failing-direction request runs
   * first, as a detached task the verify never waits for; then one practice-record update for the
   * verify, the counted passes kept for the "pass made main red" rule, the learned-list
   * observations, the audit row, and the helper is told the verify is over.
   */
  onVerifyResult(e: BorrowedVerifyResult): void {
    const ctx = this.verifies.get(e.token);
    if (!ctx) return;
    const done = () => { this.verifies.delete(e.token); void this.tellOver(ctx); };
    if (!ctx.helper || !e.flow || e.flow.helper !== ctx.helper.machineId || ctx.kind === 'main') { done(); return; }
    const helper = ctx.helper;
    const flow = e.flow;
    void this.finishVerify(ctx, helper, flow, e)
      .catch((err) => this.audit({ event: 'borrowed-seam-error', step: 'verify-result', detail: String(err instanceof Error ? err.message : err).slice(0, 200) }))
      .finally(done);
  }

  private async finishVerify(ctx: VerifyCtx, helper: HelperTarget, flow: BorrowedFlowResult, e: BorrowedVerifyResult): Promise<void> {
    const extra = await this.failingDirection(ctx, helper, flow);
    const outcomes: Partial<Record<PracticeLane, LaneVerifyOutcome>> = {};
    let sent = 0; let finished = 0; let agree = 0; let disagree = 0;
    const observations: LearnedObservation[] = [];
    const detail: Record<string, unknown> = {};
    for (const lane of PRACTICE_LANES) {
      const w = flow.lanes[lane];
      if (!w) continue;
      const x = extra.get(lane) ?? { failingAgreed: [], confirmedWrongPasses: [], environmentDifferences: 0, sent: 0, finished: 0 };
      const uniq = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])].sort();
      outcomes[lane] = {
        verifyId: ctx.token, kind: 'waiting', change: String(ctx.pr), compareOnly: ctx.assigned === 'compare-only', assigned: ctx.assigned ?? 'compare-only',
        sent: w.sent + x.sent, finished: w.finished + x.finished,
        agreed: w.agreed, digestDiffersBothPass: w.digestDiffersBothPass, helperFailedLocalPassed: w.helperFailedLocalPassed,
        confirmedWrongPasses: uniq(w.confirmedWrongPasses, x.confirmedWrongPasses), failingAgreed: uniq(w.failingAgreed, x.failingAgreed),
        environmentDifferences: w.environmentDifferences + x.environmentDifferences, check: w.check, answers: w.answers,
      };
      sent += w.sent; finished += w.finished; agree += w.agreed.length;
      const dis = w.digestDiffersBothPass.length + w.helperFailedLocalPassed.length + outcomes[lane]!.confirmedWrongPasses.length;
      disagree += dis;
      for (const f of w.helperFailedLocalPassed) observations.push({ file: f, kind: 'helper-failed-local-passed' });
      for (const f of w.digestDiffersBothPass) observations.push({ file: f, kind: 'digest-differs-both-pass' });
      for (const f of outcomes[lane]!.confirmedWrongPasses) observations.push({ file: f, kind: 'confirmed-wrong-pass' });
      for (const f of w.retrial) if (w.agreed.includes(f)) observations.push({ file: f, kind: 'agree' });
      if (w.counted.length > 0) {
        this.d.store.addCounted(helper.machineId, { pr: ctx.pr, headSha: ctx.headSha, at: this.now(), lane, files: w.counted });
        // One row per lane whose passes counted: the maturation ladder's "ran" measure.
        this.audit({ event: 'borrowed-counted', pr: ctx.pr, headSha: ctx.headSha, helper: helper.machineId, lane, files: w.counted.length });
      }
      // The file list goes in the audit row only for a verify with a hand-back, a disagreement or a discarded slice.
      const listFiles = w.takenBack > 0 || dis > 0 || w.discardedSlices > 0;
      detail[lane] = {
        sent: w.sent, finished: w.finished, counted: w.counted.length, takenBack: w.takenBack, spot: w.spot.length, late: w.late,
        discardedSlices: w.discardedSlices, check: w.check, finalLocalPass: w.finalLocalPass, agreed: w.agreed.length, disagreements: dis,
        failingAgreed: outcomes[lane]!.failingAgreed.length, environmentDifferences: outcomes[lane]!.environmentDifferences,
        ...(listFiles ? { files: (flow.sentFiles[lane] ?? []).slice(0, 200), disagreed: [...w.digestDiffersBothPass, ...w.helperFailedLocalPassed, ...outcomes[lane]!.confirmedWrongPasses].slice(0, 200) } : {}),
      };
    }
    this.recordVerify(helper.machineId, outcomes);
    // The share's finish rate reads files sent and finished (no helper or local time: throughput is measured on main verifies).
    this.d.store.addRun(helper.machineId, { at: this.now(), counted: false, slicesSent: sent, done: finished, agree, disagree, helperMs: 0, localMs: 0, prepMs: null, vitestStartMs: null });
    this.save();
    this.audit({ event: 'borrowed-verify', pr: ctx.pr, headSha: ctx.headSha, helper: helper.machineId, assigned: ctx.assigned, outcome: e.outcome, treeHash: flow.treeHash, lanes: detail });
    if (observations.length > 0 && this.d.signer) {
      const req: HelperLearnedRequest = {
        kind: 'learned', attemptId: crypto.randomBytes(16).toString('hex'), runAttemptId: ctx.runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: helper.machineId,
        treeHash: flow.treeHash, expiresAt: this.now() + HELPER_LIMITS.requestMaxLifetimeMs, observations: observations.slice(0, HELPER_LIMITS.maxFilesPerRequest),
      };
      try { await this.d.client.learned(helper, signHelperRequest(this.d.signer, req)); }
      catch (err) { this.audit({ event: 'borrowed-seam-error', step: 'learned', detail: String(err instanceof Error ? err.message : err).slice(0, 200) }); }
    }
  }

  /**
   * Asking for the failing direction (spec F): after the record, the files whose final local result
   * failed are sent to the helper, compare-only, on the same tree (the helper keeps it until the
   * verify is over). Waits at most 10 minutes; nothing waits for it. Per lane: files where the
   * helper failed at least one of the same tests, confirmed wrong passes, and environment differences.
   */
  private async failingDirection(ctx: VerifyCtx, helper: HelperTarget, flow: BorrowedFlowResult): Promise<Map<PracticeLane, { failingAgreed: string[]; confirmedWrongPasses: string[]; environmentDifferences: number; sent: number; finished: number }>> {
    const out = new Map<PracticeLane, { failingAgreed: string[]; confirmedWrongPasses: string[]; environmentDifferences: number; sent: number; finished: number }>();
    if (!this.d.signer) return out;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    const asked = new Map<string, { lane: PracticeLane; files: Map<string, { failedTests: string[]; confirmed: boolean }> }>();
    for (const lane of PRACTICE_LANES) {
      const w = flow.lanes[lane];
      if (!w) continue;
      const compared = new Set([...w.agreed, ...w.digestDiffersBothPass, ...w.helperFailedLocalPassed, ...w.confirmedWrongPasses, ...w.failingAgreed]);
      const files = w.localFailed.filter((f) => !compared.has(f.file) && !isBorrowedCanaryFile(f.file) && laneOfTestFile(f.file) === lane).slice(0, 50);
      if (files.length === 0) continue;
      const now = this.now();
      const req: HelperSliceRequest = {
        kind: 'slice', attemptId: crypto.randomBytes(16).toString('hex'), runAttemptId: ctx.runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: helper.machineId,
        expiresAt: now + HELPER_LIMITS.requestMaxLifetimeMs, lane, baseSha: ctx.baseSha, headSha: ctx.headSha, files: files.map((f) => f.file),
        deadlineAt: now + BORROWED_PROXY.failingDirectionMs, budgetMs: HELPER_LIMITS.sliceBudgetMs[lane], use: 'compare',
      };
      const r = await this.d.client.slice(helper, signHelperRequest(this.d.signer, req), BORROWED_PROXY.callTimeoutMs).catch(() => null);
      const ans = r ? parseHelperAnswer(r.body) : null;
      this.audit({ event: 'borrowed-failing-direction-sent', pr: ctx.pr, helper: helper.machineId, lane, files: files.length, state: ans?.state ?? 'no-answer' });
      if (!ans || ans.state !== 'queued') continue;
      ctx.issued.set(req.attemptId, { lane, files: req.files, use: 'compare' });
      asked.set(req.attemptId, { lane, files: new Map(files.map((f) => [f.file, { failedTests: f.failedTests, confirmed: f.confirmed }])) });
      out.set(lane, { failingAgreed: [], confirmedWrongPasses: [], environmentDifferences: 0, sent: files.length, finished: 0 });
    }
    const until = this.now() + BORROWED_PROXY.failingDirectionMs;
    while (asked.size > 0 && this.now() < until) {
      await sleep(BORROWED_PROXY.failingDirectionPollMs);
      const st = await this.d.client.status(helper, undefined, { run: ctx.runAttemptId }, BORROWED_PROXY.callTimeoutMs).catch(() => null);
      if (!st || !st.raw || verifyHelperStatus(st.raw, helper.machineId, this.d.keyLookup(), this.now())) continue;
      for (const r of this.checkedResults(ctx, helper, st)) {
        const a = asked.get(String(r.attemptId));
        if (!a) continue;
        if (r.state === 'queued' || r.state === 'preparing') continue;
        asked.delete(String(r.attemptId));
        const o = out.get(a.lane)!;
        const perFile = (r.perFile as Array<{ file: string; tests: number; failed: number; digest: string | null; failedTests: string[] }>);
        const slice = r.slice as { unhandledErrors?: number; exitCode?: number | null } | null;
        // Only a valid answer on this verify's own tree; a slice error is not compared (spec "A failure from a helper is not a result" holds both ways).
        if (r.valid !== true || r.treeHash !== flow.treeHash || !slice) continue;
        for (const p of perFile) {
          const local = a.files.get(p.file);
          if (!local) continue;
          o.finished++;
          const helperPassed = p.tests >= 1 && p.failed === 0 && p.digest !== null;
          if (helperPassed) { if (local.confirmed) o.confirmedWrongPasses.push(p.file); continue; }
          if (p.tests >= 1 && p.failedTests.some((t) => local.failedTests.includes(t))) o.failingAgreed.push(p.file);
          else o.environmentDifferences++;
        }
      }
    }
    return out;
  }

  /**
   * A `main` verify went red: any helper pass that counted for a change now merged into that head,
   * on a file that failed there, is a "pass that made main red" (the owner hears). Each counted
   * entry is reported once and then dropped.
   */
  onMainRed(e: BorrowedMainRed): void {
    // The coordinator tells each peer that runs helpers: their counted passes live in their own practice record.
    if (this.coordinator() && this.d.postPeerMainRed && e.failedFiles.length > 0) {
      for (const [machineId, p] of this.peerSeen) {
        if (p.helpers.length === 0) continue;
        const body = { coordinatorMachineId: this.d.machineId, headSha: e.headSha, failedFiles: e.failedFiles.slice(0, 200) };
        const send = (attempt: number): void => {
          void this.d.postPeerMainRed!({ machineId, url: p.url }, body).catch(() => false).then((ok) => {
            this.audit({ event: 'main-red-sent', peer: machineId, headSha: e.headSha, ok, attempt });
            // One more try a minute later; after that the notice is lost and the audit row says so.
            if (!ok && attempt === 1) { const t = setTimeout(() => send(2), BORROWED_PROXY.mainRedRetryMs); t.unref?.(); }
          });
        };
        send(1);
      }
    }
    this.checkMainRed(e);
  }

  /** This machine's counted passes against a red `main`: each hit is a `main-red-after-pass` event, once. */
  private checkMainRed(e: BorrowedMainRed): void {
    if (this.cfg().mode === 'off' || e.failedFiles.length === 0 || !this.d.isAncestor) return;
    const failed = new Set(e.failedFiles);
    void (async () => {
      let changed = false;
      for (const id of this.d.store.helperIds()) {
        const h = this.d.store.get(id);
        const keep = [];
        for (const c of h.counted) {
          const hit = c.files.filter((f) => failed.has(f));
          if (hit.length === 0) { keep.push(c); continue; }
          const merged = await this.d.isAncestor!(c.headSha, e.headSha).catch(() => null);
          if (merged !== true) { keep.push(c); continue; }
          changed = true;
          for (const file of hit.slice(0, 5)) {
            const ev: HelperEvent = { id: newEventId(), at: this.now(), runMachineId: this.d.machineId, helper: id, lane: c.lane, kind: 'main-red-after-pass', file, change: String(c.pr) };
            this.d.store.addEvent(ev);
            this.audit({ event: 'borrowed-helper-event', ...ev, at: new Date(ev.at).toISOString(), mainHead: e.headSha });
            if (this.coordinator()) this.tell(ev, this.d.store.events());
          }
        }
        h.counted = keep;
      }
      if (changed) this.save();
    })().catch((err) => this.audit({ event: 'borrowed-seam-error', step: 'main-red', detail: String(err instanceof Error ? err.message : err).slice(0, 200) }));
  }

  /** Peer side: the coordinator's red `main`, checked against this machine's counted passes (once per call, never forwarded). */
  acceptPeerMainRed(body: unknown, lease: { holdsLease: boolean; holderMachineId: string | null }): BorrowedHttpAnswer {
    if (this.cfg().mode === 'off') return { status: 404, body: { error: 'not found' } };
    if (lease.holdsLease) return { status: 409, body: { ok: false, reason: 'is-lease-holder' } };
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b) || !only(b, ['coordinatorMachineId', 'headSha', 'failedFiles'])) return { status: 400, body: { ok: false, reason: 'invalid-request' } };
    if (typeof b.coordinatorMachineId !== 'string' || !lease.holderMachineId || b.coordinatorMachineId !== lease.holderMachineId) return { status: 409, body: { ok: false, reason: 'not-coordinator' } };
    if (typeof b.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(b.headSha)) return { status: 400, body: { ok: false, reason: 'invalid-request' } };
    const files = b.failedFiles;
    if (!Array.isArray(files) || files.length < 1 || files.length > 200 || !files.every((f) => typeof f === 'string' && isRequestFile(f))) return { status: 400, body: { ok: false, reason: 'invalid-request' } };
    this.checkMainRed({ headSha: b.headSha, failedFiles: files as string[] });
    return { status: 200, body: { ok: true } };
  }

  /** The compare-only assignment drawn for an in-flight verify of a waiting change (null: none drawn). */
  assignmentFor(token: string): BorrowedAssignment | null {
    return this.verifies.get(token)?.assigned ?? null;
  }

  // ── the loopback proxy ──────────────────────────────────────────────

  private verifyFor(token: string | undefined): VerifyCtx | null {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const want = Buffer.from(token, 'utf-8');
    for (const ctx of this.verifies.values()) {
      if (ctx.endedAt !== null) continue;
      const have = Buffer.from(ctx.token, 'utf-8');
      if (have.length === want.length && crypto.timingSafeEqual(have, want)) return ctx;
    }
    return null;
  }

  async proxy(token: string | undefined, body: unknown, route: BorrowedRouteFacts): Promise<BorrowedHttpAnswer> {
    const refused = (status: number, reason: string): BorrowedHttpAnswer => ({ status, body: { ok: false, reason } });
    const where = proxyRouteRefusal(route);
    if (where) { this.audit({ event: 'borrowed-proxy-refused', reason: where }); return refused(403, where); }
    const cfg = this.cfg();
    // Dark: with the setting absent the route does not exist.
    if (cfg.mode === 'off') return refused(404, 'not-found');
    const ctx = this.verifyFor(token);
    if (!ctx) { this.audit({ event: 'borrowed-proxy-refused', reason: 'unknown-attempt' }); return refused(401, 'unknown-attempt'); }
    if (ctx.kind === 'main') return refused(409, 'main-verify');
    const op = parseProxyOp(body);
    if (!op) return refused(400, 'invalid-request');
    const helper = ctx.helper;
    if (!helper || !this.d.signer) return { status: 200, body: { ok: false, reason: helper ? 'no-signer' : 'no-helper' } };
    const noAnswer: BorrowedHttpAnswer = { status: 200, body: { ok: false, reason: 'no-helper-answer' } };
    const ac = new AbortController();
    const onEnd = () => ac.abort();
    ctx.abort.signal.addEventListener('abort', onEnd, { once: true });
    let timer: NodeJS.Timeout | null = null;
    const limit = new Promise<BorrowedHttpAnswer>((resolve) => {
      timer = setTimeout(() => { ac.abort(); resolve(noAnswer); }, BORROWED_PROXY.callTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.proxyOp(ctx, helper, op, cfg, ac.signal).catch((e) => {
        this.audit({ event: 'borrowed-proxy-error', op: op.op, detail: String(e instanceof Error ? e.message : e).slice(0, 200) });
        return noAnswer;
      }), limit]);
    } finally {
      if (timer) clearTimeout(timer);
      ctx.abort.signal.removeEventListener('abort', onEnd);
    }
  }

  /** Per lane: its state, whether a pass may count, whether a dry run proved it, its share, and the files not yet compared on. */
  private laneFacts(helper: string, mode: BorrowedConfig['mode']): Record<string, { state: string; mayCount: boolean; proven: boolean; share: number; uncovered: string[] }> {
    const out: Record<string, { state: string; mayCount: boolean; proven: boolean; share: number; uncovered: string[] }> = {};
    const share = laneShareFromRuns(this.d.store.get(helper).runs);
    for (const lane of PRACTICE_LANES) {
      const l = this.d.store.peekLane(helper, lane);
      out[lane] = { state: l?.state ?? 'practice', mayCount: mayCount(l, mode), proven: laneProven(l), share, uncovered: l?.coverage?.uncovered ?? [] };
    }
    return out;
  }

  private async proxyOp(ctx: VerifyCtx, helper: HelperTarget, op: ProxyOp, cfg: BorrowedConfig, signal: AbortSignal): Promise<BorrowedHttpAnswer> {
    const noAnswer: BorrowedHttpAnswer = { status: 200, body: { ok: false, reason: 'no-helper-answer' } };
    // No answer to the verify's one status request means no helper for that verify.
    const answered = await ctx.asked;
    if (op.op === 'plan') {
      const h = this.d.store.get(helper.machineId);
      const st = ctx.status;
      const owner = (st?.raw as { owner?: { workersFree?: unknown; workersMax?: unknown } } | undefined)?.owner;
      const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
      return { status: 200, body: {
        ok: true, helper: helper.machineId, mode: cfg.mode, assigned: ctx.assigned, answered, runAttemptId: ctx.runAttemptId,
        lanes: this.laneFacts(helper.machineId, cfg.mode), spotOneIn: spotRateOneIn(h.spot),
        learned: (st?.learned.entries ?? []).map((e) => ({ file: e.file, retrialDue: e.retrialDue === true })),
        throughput: measuredThroughput(h.runs) ?? BORROWED_PLAN.seedRelativeShare,
        prepMs: measuredPrepP90(h.runs) ?? BORROWED_PLAN.seedPrepMs,
        workersFree: owner ? count(owner.workersFree) : null,
        workersMax: owner ? count(owner.workersMax) : null,
      } };
    }
    if (!answered) return { status: 200, body: { ok: false, reason: 'no-helper' } };
    const signer = this.d.signer!;
    const now = this.now();
    const base = { runAttemptId: ctx.runAttemptId, requesterMachineId: this.d.machineId, helperMachineId: helper.machineId, expiresAt: now + HELPER_LIMITS.requestMaxLifetimeMs };

    if (op.op === 'status') {
      const st = await this.d.client.status(helper, signal, { run: ctx.runAttemptId, ...(op.since !== undefined ? { since: op.since } : {}) }, BORROWED_PROXY.callTimeoutMs);
      if (!st || !st.raw) return noAnswer;
      const why = verifyHelperStatus(st.raw, helper.machineId, this.d.keyLookup(), this.now());
      if (why) { this.audit({ event: 'borrowed-proxy-answer-refused', op: 'status', helper: helper.machineId, reason: why }); return noAnswer; }
      // The child gets only what this server checked: each finished slice of this verify, its own signature verified.
      return { status: 200, body: { ok: true, results: this.checkedResults(ctx, helper, st), tree: this.treeOf(ctx, st) } };
    }

    if (op.op === 'cancel') {
      if (op.attemptIds && !op.attemptIds.every((id) => ctx.issued.has(id))) return { status: 400, body: { ok: false, reason: 'unknown-slice' } };
      // The verify's end is told by this server, never by the child.
      if (op.verifyOver) return { status: 400, body: { ok: false, reason: 'verify-over-not-yours' } };
      const req: HelperCancelRequest = {
        kind: 'cancel', attemptId: crypto.randomBytes(16).toString('hex'), ...base,
        ...(op.attemptIds ? { attemptIds: op.attemptIds } : {}), ...(op.verifyOver ? { verifyOver: true as const } : {}),
      };
      const r = await this.d.client.cancel(helper, signHelperRequest(signer, req), signal, BORROWED_PROXY.callTimeoutMs);
      return r ? { status: 200, body: { ok: r.status === 200, helperStatus: r.status } } : noAnswer;
    }

    // prepare / slice: the commits come from this server's record of the verify, never from the caller.
    let use: HelperSliceUse | undefined;
    if (op.op === 'slice') {
      use = op.use;
      // A slice's passes may be used only where the practice record admits it and the verify was not drawn compare-only.
      if (use === 'count' && !(ctx.assigned === 'counting' && mayCount(this.d.store.peekLane(helper.machineId, op.lane), cfg.mode))) {
        return { status: 200, body: { ok: false, reason: 'count-not-admitted' } };
      }
    }
    const attemptId = crypto.randomBytes(16).toString('hex');
    const req: HelperSliceRequest = {
      kind: 'slice', attemptId, ...base, lane: op.lane, baseSha: ctx.baseSha, headSha: ctx.headSha,
      files: op.op === 'slice' ? op.files : [], deadlineAt: now + op.deadlineInMs, budgetMs: op.op === 'slice' ? op.budgetMs : 1,
      ...(op.op === 'slice' ? { use: use as HelperSliceUse } : { prepare: true as const }),
      ...(op.op === 'slice' && op.retrial ? { retrial: true as const } : {}),
    };
    const r = await this.d.client.slice(helper, signHelperRequest(signer, req), BORROWED_PROXY.callTimeoutMs, signal);
    if (!r) return noAnswer;
    const ans = parseHelperAnswer(r.body);
    if (!ans) {
      // An unsigned refusal (the request never reached the helper's signer): passed on as a reason, never as a result.
      const reason = (r.body as { reason?: unknown } | null)?.reason;
      return { status: 200, body: { ok: false, reason: 'helper-refused', helperStatus: r.status, ...(typeof reason === 'string' ? { helperReason: reason.slice(0, 100) } : {}) } };
    }
    const sig = verifyHelperAnswer(ans, helper.machineId, this.d.keyLookup(), this.now());
    if (sig || ans.attemptId !== attemptId || ans.runAttemptId !== ctx.runAttemptId) {
      this.audit({ event: 'borrowed-proxy-answer-refused', op: op.op, helper: helper.machineId, reason: sig ?? 'wrong-ids' });
      return noAnswer;
    }
    if (op.op === 'slice') ctx.issued.set(attemptId, { lane: op.lane, files: [...op.files], use: use as HelperSliceUse });
    return { status: 200, body: { ok: true, attemptId, state: ans.state, ...(ans.reason ? { reason: String(ans.reason).slice(0, 60) } : {}) } };
  }

  /** The verify's tree on the helper, as its status names it. */
  private treeOf(ctx: VerifyCtx, st: HelperStatusView): { state: string; treeHash: string | null } {
    const t = st.trees.find((x) => x.headSha === ctx.headSha && ((x as { baseSha?: unknown }).baseSha === undefined || (x as { baseSha?: unknown }).baseSha === ctx.baseSha));
    if (!t) return { state: 'none', treeHash: null };
    const treeHash = (t as { treeHash?: unknown }).treeHash;
    return { state: t.state, treeHash: typeof treeHash === 'string' && /^[0-9a-f]{40,64}$/.test(treeHash) ? treeHash : null };
  }

  /**
   * Every finished slice of this verify in a status answer, checked here: the slice's own
   * signature, its ids (this verify, a slice this server issued), its lane and commits, and that it
   * lists each requested file exactly once. A slice that fails any check is passed on as invalid
   * with no results. Pure apart from the key lookup and the clock.
   */
  private checkedResults(ctx: VerifyCtx, helper: HelperTarget, st: HelperStatusView): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const r of st.results) {
      const ans = parseHelperAnswer(r.answer);
      if (!ans || ans.runAttemptId !== ctx.runAttemptId) continue;
      const iss = ctx.issued.get(ans.attemptId);
      if (!iss) continue;
      const sig = verifyHelperAnswer(ans, helper.machineId, this.d.keyLookup(), this.now());
      const idsOk = ans.lane === iss.lane && ans.baseSha === ctx.baseSha && ans.headSha === ctx.headSha
        && ans.requestedFiles.length === iss.files.length && ans.requestedFiles.every((f, i) => f === iss.files[i]);
      let filesOk = true;
      if (ans.state === 'done' && !ans.resultOversize) {
        const seen = new Set<string>();
        for (const p of ans.perFile) { if (!iss.files.includes(p.file) || seen.has(p.file)) { filesOk = false; break; } seen.add(p.file); }
        if (seen.size !== iss.files.length) filesOk = false;
      } else if (ans.perFile.some((p) => !iss.files.includes(p.file))) filesOk = false;
      // An oversize result is discarded for its content (no results, no slice facts), not an invalid answer.
      const valid = !sig && idsOk && filesOk;
      if (!valid) this.audit({ event: 'borrowed-answer-invalid', pr: ctx.pr, helper: helper.machineId, attemptId: ans.attemptId, reason: sig ?? (!idsOk ? 'ids' : 'per-file') });
      out.push({
        seq: r.seq, attemptId: ans.attemptId, valid, state: ans.state, treeHash: ans.treeHash,
        perFile: valid && !ans.resultOversize ? ans.perFile : [], slice: ans.resultOversize ? null : ans.slice,
      });
    }
    return out;
  }

  // ── the decision to count, the dry-run request, "I am here" ─────────

  private helperOf(id: unknown): HelperTarget | null {
    if (typeof id !== 'string' || !MACHINE_ID_RE.test(id)) return null;
    return this.cfg().helpers.find((h) => h.machineId === id) ?? null;
  }

  /**
   * Record the throughput session's decision to count for a helper and lane. Refused when the
   * admission rule does not hold. Written to the practice record, the audit log and the maturation
   * ladder's evidence log.
   */
  decide(body: unknown): BorrowedHttpAnswer {
    if (this.cfg().mode === 'off') return { status: 404, body: { error: 'not found' } };
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b) || !only(b, ['helper', 'lane', 'reason', 'sevenDayException', 'by'])) return { status: 400, body: { ok: false, code: 'invalid-request' } };
    if (!isLane(b.lane) || typeof b.reason !== 'string' || b.reason.trim().length < 1 || b.reason.length > 500) return { status: 400, body: { ok: false, code: 'invalid-request' } };
    if (b.sevenDayException !== undefined && typeof b.sevenDayException !== 'boolean') return { status: 400, body: { ok: false, code: 'invalid-request' } };
    if (b.by !== undefined && !(typeof b.by === 'string' && b.by.length >= 1 && b.by.length <= 200)) return { status: 400, body: { ok: false, code: 'invalid-request' } };
    const helper = this.helperOf(b.helper);
    if (!helper) return { status: 404, body: { ok: false, code: 'unknown-helper' } };
    const lane = b.lane;
    const now = this.now();
    const d = { reason: b.reason.trim(), sevenDayException: b.sevenDayException === true, by: typeof b.by === 'string' ? b.by : null };
    const before = this.d.store.lane(helper.machineId, lane, now);
    const r = recordDecision(before, d, now);
    const progress = evidenceProgress(before);
    if (!r.ok) {
      this.audit({ event: 'borrowed-decision-refused', helper: helper.machineId, lane, code: r.code, missing: r.admission.missing, sevenDayException: d.sevenDayException });
      try { this.d.evidence?.({ kind: 'held', reason: `count-decision-refused:${r.code}`, subject: helper.machineId, context: { lane, sevenDayException: d.sevenDayException, missing: r.admission.missing.join(',') } }); } catch { /* @silent-fallback-ok: a lost evidence row costs a sample */ }
      return { status: 409, body: { ok: false, code: r.code, missing: r.admission.missing, evidence: progress } };
    }
    this.d.store.setLane(helper.machineId, lane, r.lane);
    try { this.d.store.save(); } catch (e) {
      // Not durable: the decision is not recorded.
      this.d.store.setLane(helper.machineId, lane, before);
      this.audit({ event: 'borrowed-state-unwritable', detail: String(e instanceof Error ? e.message : e).slice(0, 200) });
      return { status: 503, body: { ok: false, code: 'state-unwritable' } };
    }
    this.audit({ event: 'borrowed-decision', helper: helper.machineId, lane, reason: d.reason, sevenDayException: d.sevenDayException, usedException: r.admission.usedException, by: d.by, evidence: progress, mode: this.cfg().mode });
    try { this.d.evidence?.({ kind: 'fired', reason: 'count-decision', subject: helper.machineId, context: { lane, sevenDayException: d.sevenDayException, usedException: r.admission.usedException, decidedBy: d.by, runMachine: this.d.machineId } }); } catch { /* @silent-fallback-ok: a lost evidence row costs a sample */ }
    return { status: 200, body: { ok: true, helper: helper.machineId, lane, state: r.lane.state, usedException: r.admission.usedException, mode: this.cfg().mode, evidence: progress } };
  }

  /**
   * Record a request to dry-run a helper (or to stop one). The dry-run task starts or stops on the
   * next tick (borrowedDryRun.ts); a dry run already running keeps going on a repeated start.
   */
  dryRun(body: unknown): BorrowedHttpAnswer {
    if (this.cfg().mode === 'off') return { status: 404, body: { error: 'not found' } };
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b) || !only(b, ['helper', 'lanes', 'action', 'by'])) return { status: 400, body: { ok: false, code: 'invalid-request' } };
    const action = b.action === undefined ? 'start' : b.action;
    if (action !== 'start' && action !== 'stop') return { status: 400, body: { ok: false, code: 'invalid-request' } };
    let lanes: PracticeLane[] = [...PRACTICE_LANES];
    if (b.lanes !== undefined) {
      if (!Array.isArray(b.lanes) || b.lanes.length < 1 || b.lanes.length > 3 || !b.lanes.every(isLane)) return { status: 400, body: { ok: false, code: 'invalid-request' } };
      lanes = [...new Set(b.lanes as PracticeLane[])];
    }
    if (b.by !== undefined && !(typeof b.by === 'string' && b.by.length >= 1 && b.by.length <= 200)) return { status: 400, body: { ok: false, code: 'invalid-request' } };
    const helper = this.helperOf(b.helper);
    if (!helper) return { status: 404, body: { ok: false, code: 'unknown-helper' } };
    const h = this.d.store.get(helper.machineId);
    h.dryRunIntent = { requestedAt: this.now(), lanes, by: typeof b.by === 'string' ? b.by : null, state: action === 'start' ? 'requested' : 'stopped' };
    try { this.d.store.save(); } catch { return { status: 503, body: { ok: false, code: 'state-unwritable' } }; }
    this.audit({ event: 'borrowed-dry-run-requested', helper: helper.machineId, lanes, action, by: h.dryRunIntent.by });
    return { status: 202, body: { ok: true, helper: helper.machineId, intent: h.dryRunIntent } };
  }

  /** The helper's signed "I am here": verified against the paired helper's machine key, it restores asking on every verify. */
  helperHere(body: unknown, route: BorrowedRouteFacts): BorrowedHttpAnswer {
    if (this.cfg().mode === 'off') return { status: 404, body: { error: 'not found' } };
    const present = (v: string | string[] | undefined): boolean => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
    if (present(route.cfConnectingIp)) return { status: 403, body: { ok: false, reason: 'tunnel' } };
    const h = parseHelperHere(body);
    if (!h) return { status: 400, body: { ok: false, reason: 'invalid-request' } };
    const helper = this.helperOf(h.helperMachineId);
    if (!helper) { this.audit({ event: 'helper-here-refused', helper: h.helperMachineId, reason: 'unknown-helper' }); return { status: 403, body: { ok: false, reason: 'unknown-helper' } }; }
    const why = verifyHelperHere(h, helper.machineId, this.d.machineId, this.d.keyLookup(), this.now());
    if (why) { this.audit({ event: 'helper-here-refused', helper: helper.machineId, reason: why }); return { status: why === 'expired' || why === 'wrong-run-machine' ? 409 : 401, body: { ok: false, reason: why } }; }
    this.asking.here(helper.machineId);
    this.audit({ event: 'helper-here', helper: helper.machineId, why: h.why, runnerVersion: h.runnerVersion });
    return { status: 200, body: { ok: true } };
  }

  // ── baseline results ────────────────────────────────────────────────

  wantsMainFileCounts(): boolean {
    if (this.cfg().mode !== 'off') return true;
    for (const p of this.peerSeen.values()) if (p.wantsBaseline) return true;
    return false;
  }

  onGreenMain(e: BorrowedGreenMain): void {
    if (!this.wantsMainFileCounts() || !this.coordinator()) return;
    if (e.fileCounts === undefined || e.fileCounts === null) { this.audit({ event: 'main-file-counts-skipped', commit: e.commit, reason: 'not-carried' }); return; }
    const files = parseFileCounts(e.fileCounts);
    if (!files) { this.audit({ event: 'main-file-counts-skipped', commit: e.commit, reason: 'malformed' }); return; }
    try { this.d.baseline.add({ commit: e.commit, finishedAt: e.finishedAt, machineId: e.machineId, files }); }
    catch (err) { this.audit({ event: 'main-file-counts-skipped', commit: e.commit, reason: 'unwritable', detail: String(err instanceof Error ? err.message : err).slice(0, 200) }); return; }
    void this.pushBaseline();
  }

  /** Coordinator: send the baseline file to each peer that wants it and has not acknowledged this version. */
  private async pushBaseline(): Promise<void> {
    /* @self-action-controller: local-verify-borrowed-baseline-push */
    if (!this.d.postPeerBaseline || !this.coordinator()) return;
    for (const [machineId, p] of this.peerSeen) {
      if (!p.wantsBaseline) continue;
      try {
        const cur = this.d.baseline.read();
        if (!cur.ok) return;
        const sent = this.peerBaseline.get(machineId) ?? { hash: null, triedHash: null, triedAt: 0, tries: 0 };
        if (sent.hash === cur.hash) continue;
        // The same version offered and not stored: again only after the retry time, at most a few times. A new version goes at once.
        const same = sent.triedHash === cur.hash;
        if (same && (this.now() - sent.triedAt < BORROWED_PROXY.baselineRetryMs || sent.tries >= BORROWED_PROXY.baselineMaxTries)) continue;
        const tries = same ? sent.tries + 1 : 1;
        this.peerBaseline.set(machineId, { hash: sent.hash, triedHash: cur.hash, triedAt: this.now(), tries });
        const ok = await this.d.postPeerBaseline({ machineId, url: p.url }, { coordinatorMachineId: this.d.machineId, file: cur.file });
        this.audit({ event: 'main-file-counts-sent', peer: machineId, hash: cur.hash, ok });
        if (ok) this.peerBaseline.set(machineId, { hash: cur.hash, triedHash: cur.hash, triedAt: this.now(), tries });
        else if (tries >= BORROWED_PROXY.baselineMaxTries) this.audit({ event: 'main-file-counts-send-gave-up', peer: machineId, hash: cur.hash, tries });
      } catch (err) {
        this.audit({ event: 'borrowed-seam-error', step: 'push-baseline', detail: String(err instanceof Error ? err.message : err).slice(0, 200) });
      }
    }
  }

  /** Peer side: the coordinator's copy of the baseline results. A peer never writes its own. */
  acceptPeerBaseline(body: unknown, lease: { holdsLease: boolean; holderMachineId: string | null }): BorrowedHttpAnswer {
    if (this.cfg().mode === 'off') return { status: 404, body: { error: 'not found' } };
    if (lease.holdsLease) return { status: 409, body: { ok: false, reason: 'is-lease-holder' } };
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b) || !only(b, ['coordinatorMachineId', 'file'])) return { status: 400, body: { ok: false, reason: 'invalid-request' } };
    if (typeof b.coordinatorMachineId !== 'string' || !lease.holderMachineId || b.coordinatorMachineId !== lease.holderMachineId) return { status: 409, body: { ok: false, reason: 'not-coordinator' } };
    const file = parseMainFileCounts(b.file);
    if (!file) return { status: 400, body: { ok: false, reason: 'invalid-request' } };
    // A peer keeps what the coordinator keeps: at most three, plus its pinned ones.
    if (file.baselines.length > MAIN_FILE_COUNTS_LIMITS.baselines + MAIN_FILE_COUNTS_LIMITS.pinned) return { status: 400, body: { ok: false, reason: 'invalid-request' } };
    try {
      const hash = this.d.baseline.replace(file);
      return { status: 200, body: { ok: true, hash } };
    } catch (err) {
      this.audit({ event: 'main-file-counts-skipped', reason: 'unwritable', detail: String(err instanceof Error ? err.message : err).slice(0, 200) });
      return { status: 503, body: { ok: false, reason: 'state-unwritable' } };
    }
  }

  // ── the peer exchange ───────────────────────────────────────────────

  peerStatusExtras(): BorrowedPeerStatusExtras {
    const cfg = this.cfg();
    if (cfg.mode === 'off' || cfg.helpers.length === 0) return {};
    return {
      wantsBaseline: true,
      helpers: cfg.helpers.map((h) => h.machineId),
      helperEvents: this.d.store.events().slice(-HELPER_EVENT_LIMITS.perStatus),
    };
  }

  onPeerStatus(peer: { machineId: string; url: string }, extras: BorrowedPeerStatusExtras): void {
    const helpers = Array.isArray(extras.helpers) ? extras.helpers.filter((h): h is string => typeof h === 'string' && MACHINE_ID_RE.test(h)).slice(0, 2) : [];
    const events = extras.helperEvents === undefined ? [] : parseHelperEvents(extras.helperEvents, peer.machineId);
    if (events === null) this.audit({ event: 'borrowed-peer-events-refused', peer: peer.machineId });
    const prev = this.peerSeen.get(peer.machineId);
    const wants = extras.wantsBaseline === true;
    if (!wants && helpers.length === 0 && !prev) return; // a peer with no helper: nothing to keep
    this.peerSeen.set(peer.machineId, { url: peer.url, wantsBaseline: wants, helpers, events: events ?? prev?.events ?? [] });
    // Every helper this peer reported in the last day: a verify that started with one keeps its record
    // even when the peer's setting is switched off before its record is imported.
    const ever = this.peerHelpersEver.get(peer.machineId) ?? new Map<string, number>();
    for (const h of helpers) ever.set(h, this.now());
    for (const [h, at] of ever) if (this.now() - at > BORROWED_PROXY.peerHelperMemoryMs) ever.delete(h);
    this.peerHelpersEver.set(peer.machineId, ever);
    if (!this.coordinator()) return;
    if (events && events.length > 0) {
      const fresh = untold(events, this.d.store.told());
      if (fresh.length > 0) {
        for (const e of fresh) this.tell(e, events);
        this.save();
      }
    }
    if (wants) void this.pushBaseline();
  }

  knownHelper(helper: string, peerMachineId?: string): boolean {
    if (peerMachineId === undefined) return this.cfg().helpers.some((h) => h.machineId === helper);
    return this.peerHelpersSeen(peerMachineId).includes(helper);
  }

  /** The helpers a peer reported in the last day (its current ones included). */
  peerHelpersSeen(peerMachineId: string): string[] {
    const now = [...(this.peerSeen.get(peerMachineId)?.helpers ?? [])];
    for (const [h, at] of this.peerHelpersEver.get(peerMachineId) ?? []) if (this.now() - at <= BORROWED_PROXY.peerHelperMemoryMs && !now.includes(h)) now.push(h);
    return now;
  }

  // ── every tick ──────────────────────────────────────────────────────

  tick(): void {
    // A session whose child ended and whose result never came (a crash, a restart of the result path): told over and dropped.
    for (const [token, ctx] of this.verifies) {
      if (ctx.endedAt !== null && this.now() - ctx.endedAt > BORROWED_PROXY.endedKeepMs) { this.verifies.delete(token); void this.tellOver(ctx); }
    }
    const cfg = this.cfg();
    if (cfg.mode === 'off') { this.dryRunTask?.stopAll(); return; }
    // A requested dry run starts, a stopped one ends (never awaited).
    try { this.dryRunTask?.tick(cfg.helpers); } catch (err) { this.audit({ event: 'borrowed-seam-error', step: 'dry-run', detail: String(err instanceof Error ? err.message : err).slice(0, 200) }); }
    let changed = false;
    for (const h of cfg.helpers) {
      for (const lane of PRACTICE_LANES) {
        const cur = this.d.store.peekLane(h.machineId, lane);
        if (!cur) continue;
        const t = noteTime(cur, this.now());
        if (t.events.length > 0) { this.applyTransition(h.machineId, lane, t); changed = true; }
      }
    }
    // A machine that became the coordinator tells what it has not told yet.
    if (this.coordinator()) {
      const all = this.d.store.events();
      const fresh = untold(all, this.d.store.told());
      for (const e of fresh) this.tell(e, all);
      if (fresh.length > 0) changed = true;
      void this.pushBaseline();
    }
    if (changed) this.save();
  }

  // ── GET /local-verify ───────────────────────────────────────────────

  private laneInfo(l: LaneRecord, mode: BorrowedConfig['mode']): Record<string, unknown> {
    const p = evidenceProgress(l);
    return {
      state: l.state,
      mayCount: mayCount(l, mode),
      // A dry run proved the lane: files worth at least half of its time passed on the helper.
      proven: laneProven(l),
      practiceStartedAt: new Date(l.practiceStartedAt).toISOString(),
      identity: l.identity,
      evidence: {
        coverage: { ...p.coverage, complete: coverageComplete(p) },
        spread: { ...p.spread, complete: spreadComplete(p) },
        failingDirection: { comparisons: p.failing.comparisons, files: p.failing.files, verifies: p.failing.verifies, environmentDifferences: p.failing.environmentDifferences, complete: failingDirectionComplete(p, false), completeUnderException: failingDirectionComplete(p, true) },
        checkSlice: { seen: p.failing.checksSeen, right: p.failing.checksRight, complete: checkSliceComplete(p) },
        wrongPassWindow: { ...p.wrongPass, complete: wrongPassWindowClear(p) },
      },
      decision: l.decision ? { at: new Date(l.decision.at).toISOString(), reason: l.decision.reason, sevenDayException: l.decision.sevenDayException, by: l.decision.by } : null,
      lapses: l.lapses.slice(-5).map((x) => ({ at: new Date(x.at).toISOString(), reason: x.reason, fault: x.fault })),
      // The last verify's share of the lane and how much of it the helper finished.
      lastVerify: l.last ? { at: new Date(l.last.at).toISOString(), assigned: l.last.assigned, sent: l.last.sent, finished: l.last.finished } : null,
    };
  }

  info(): unknown {
    const cfg = this.cfg();
    const baseline = cfg.mode === 'off' && !this.wantsMainFileCounts() ? null : (() => {
      const r = this.d.baseline.read();
      return r.ok ? { ok: true, hash: r.hash, baselines: r.file.baselines.map((b) => ({ commit: b.commit, finishedAt: b.finishedAt, machineId: b.machineId, files: Object.keys(b.files).length })), pinned: r.file.pinned } : { ok: false, reason: r.reason };
    })();
    return {
      mode: cfg.mode,

      helpers: cfg.helpers.map((h) => {
        const st = this.d.store.get(h.machineId);
        return {
          machineId: h.machineId, url: h.url,
          asking: { ...st.ask, silentSince: st.ask.silentSince === null ? null : new Date(st.ask.silentSince).toISOString() },
          spotOneIn: spotRateOneIn(st.spot), spotRaisedVerifiesLeft: st.spot.raisedVerifiesLeft,
          dryRunIntent: st.dryRunIntent, dryRunRunning: this.dryRunTask?.isRunning(h.machineId) ?? false,
          lanes: Object.fromEntries(PRACTICE_LANES.map((lane) => [lane, st.lanes[lane] ? this.laneInfo(st.lanes[lane] as LaneRecord, cfg.mode) : { state: 'practice', mayCount: false, evidence: null, decision: null, lapses: [], lastVerify: null }])),
        };
      }),
      events: this.d.store.events().slice(-20),
      baseline,
    };
  }
}
