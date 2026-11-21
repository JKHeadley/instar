/**
 * GeminiPaygReleaseRecorder — the release gate of the Gemini pay-per-use door
 * (docs/specs/gemini-payg-metered-lane.md §8 "Release gate", "Release checks").
 *
 * THE ONLY CODE PATH THAT SETS `live`, and the only module (with MeteredSpendGate,
 * which defines it) allowed to import `mintReleaseProofMarker` — a unit test pins the
 * import ban. After the PIN go-live the door is `armed-pending-proof`: the gate admits
 * exactly one caller, `release-proof`, and only with a marker minted here.
 *
 * The proof call:
 *   - ONE durable proof reservation at a time, bound to the APPLIED intent hash. Its
 *     callId is derived from (intent hash, attempt number), so a repeat submission —
 *     concurrent, or after a restart — dedupes in the ledger and returns the recorded
 *     outcome; it never makes a second paid call.
 *   - A confirmed no-charge outcome releases the slot for a retry (it does not count).
 *   - An uncertain outcome (a provisional booking) keeps its charge; up to 2 further
 *     attempts are allowed, each a new booked reservation through the full gate.
 *   - Holder only. A forwarded `release-proof-forward` is stamped HERE on the holder,
 *     only while armed-pending-proof, only on the cheapest verified model, at no more
 *     than 64 output tokens. Nothing in the request payload reaches the call.
 *
 * The checks, in order (§8): (d) prices verified → (a)+(e) the one settled proof row
 * whose door === ledger door === priced door (forwarded from another machine on a
 * multi-machine agent) → (c) one real `browser-read` reconciliation record → (b) on a
 * multi-machine agent, the signed live-test PASS artifact. Any unmet check leaves the
 * door `armed-pending-proof` with the blocker named. No check is ever relaxed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mintReleaseProofMarker } from './MeteredSpendGate.js';
import type { RoutingSpendCapsStore } from './RoutingSpendCapsStore.js';
import type { ReservationView } from './MeteredSpendLedger.js';
import type { GeminiPaygReconciliationStore } from './geminiPaygReconciliation.js';

export const GEMINI_PROOF_PROMPT = 'Reply with the single word: ready';
export const GEMINI_PROOF_MAX_OUTPUT_TOKENS = 64;
export const GEMINI_PROOF_MAX_UNCERTAIN_ATTEMPTS = 3; // the first plus up to 2 further

export type ProofAttemptState = 'in-flight' | 'settled' | 'no-charge' | 'uncertain';

export interface ProofAttempt {
  n: number;
  callId: string;
  state: ProofAttemptState;
  modelId: string;
  at: string;
  reserveId?: string;
  ledgerDoor?: string;
  pricedDoor?: string;
  costUsd?: number;
  forwardedFrom: string | null;
  detail?: string;
}

export interface LiveTestRef { featureId: string; runId: string }

interface ProofRecordFile {
  intentHash: string;
  attempts: ProofAttempt[];
  liveTest?: LiveTestRef;
  releasedAt?: string;
}

export interface ReleaseCheck { id: 'd-prices-verified' | 'ae-proof-row' | 'c-reconciliation' | 'b-live-test'; ok: boolean; detail: string }

export interface ReleaseEvaluation {
  releaseState: 'armed-pending-proof' | 'live' | 'not-armed';
  checks: ReleaseCheck[];
  blocker: string | null;
}

/** What the recorder needs from the provider: one call with the marker it minted. */
export interface ProofCaller {
  call(req: {
    caller: 'release-proof';
    component: string;
    model: string;
    prompt: string;
    maxOutputTokens: number;
    callId: string;
    run: string;
    proofMarker: ReturnType<typeof mintReleaseProofMarker>;
  }): Promise<{ reserveId: string; costUsd: number; modelId: string }>;
}

export interface GeminiPaygReleaseRecorderDeps {
  stateDir: string;
  door: string;
  selfMachineId: string;
  capsStore: () => RoutingSpendCapsStore | null;
  provider: () => ProofCaller | null;
  ledgerLookup: (callId: string) => ReservationView | null;
  /** Ordered cheapest-first model ids the door may use. */
  modelsCheapestFirst: () => string[];
  /** The manifest's `verified` flag for a model's current price point. */
  modelVerified: (modelId: string) => boolean;
  reconciliation: () => GeminiPaygReconciliationStore | null;
  /** True on an agent with more than one registered machine. */
  multiMachine: () => boolean;
  /** Verify a signed live-test PASS artifact (null verifier ⇒ unmet on multi-machine). */
  verifyLiveTest?: ((ref: LiveTestRef) => { ok: boolean; reason?: string }) | null;
  now?: () => number;
}

export class GeminiPaygReleaseRecorder {
  private readonly file: string;
  private inFlight: Promise<unknown> | null = null;
  private readonly now: () => number;

  constructor(private readonly d: GeminiPaygReleaseRecorderDeps) {
    this.file = path.join(d.stateDir, 'state', 'gemini-payg-release-proof.json');
    this.now = d.now ?? (() => Date.now());
  }

  /** The intent hash applied to the door, or null when no go-live has been applied. */
  appliedIntentHash(): string | null {
    try { return this.d.capsStore()?.read().appliedIntents?.[this.d.door]?.intentHash ?? null; } catch { return null; } // @silent-fallback-ok — unreadable store: no proof can be bound, which refuses
  }

  private releaseState(): 'armed-pending-proof' | 'live' | 'not-armed' {
    try {
      const p = this.d.capsStore()?.read().doorPolicy?.[this.d.door];
      return p ? p.releaseState : 'not-armed';
    } catch { return 'not-armed'; } // @silent-fallback-ok — unreadable store reads as not armed (nothing is released)
  }

  private load(intentHash: string): ProofRecordFile {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as ProofRecordFile;
      if (v && v.intentHash === intentHash && Array.isArray(v.attempts)) return v;
    } catch { /* @silent-fallback-ok: no record yet for this intent — a fresh one is started */ }
    return { intentHash, attempts: [] };
  }

  private save(rec: ProofRecordFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(rec, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }

  /** Record the live-test artifact reference (check (b)); verified at evaluation, never trusted as given. */
  recordLiveTestRef(ref: LiveTestRef): void {
    const ih = this.appliedIntentHash();
    if (!ih) throw new Error('no applied go-live to bind the live-test artifact to');
    const rec = this.load(ih);
    rec.liveTest = { featureId: String(ref.featureId).slice(0, 160), runId: String(ref.runId).slice(0, 160) };
    this.save(rec);
  }

  /**
   * Run (or return) the proof call, then evaluate the release checks. Serialized: a
   * concurrent submission waits for the in-flight one and gets its recorded outcome.
   */
  async runProof(opts: { forwardedFrom: string | null }): Promise<{ attempt: ProofAttempt | null; evaluation: ReleaseEvaluation }> {
    while (this.inFlight) await this.inFlight.catch(() => undefined); /* @silent-fallback-ok: serialization only; the in-flight proof records its own outcome */
    const p = this.runProofOnce(opts);
    this.inFlight = p;
    try { return await p; } finally { this.inFlight = null; }
  }

  private async runProofOnce(opts: { forwardedFrom: string | null }): Promise<{ attempt: ProofAttempt | null; evaluation: ReleaseEvaluation }> {
    const intentHash = this.appliedIntentHash();
    const state = this.releaseState();
    if (!intentHash || state === 'not-armed') return { attempt: null, evaluation: { releaseState: 'not-armed', checks: [], blocker: 'not-armed: no go-live has been applied to this door on this machine' } };
    const rec = this.load(intentHash);
    // A settled proof is the recorded outcome — a repeat never makes a second paid call.
    const settled = rec.attempts.find((a) => a.state === 'settled');
    if (settled || state === 'live') return { attempt: settled ?? null, evaluation: this.evaluate() };

    // Resume an attempt a previous process left in flight: the ledger, folded from rows,
    // says what became of it (dedupe survives restart).
    const open = rec.attempts.find((a) => a.state === 'in-flight');
    if (open) {
      this.resolveFromLedger(open);
      // Calls are serialized in this process, so an attempt still in flight here was left by
      // a process that ended. With NO ledger row the reservation never happened — and the
      // reserve precedes the Google call — so it charged nothing: release the slot.
      if (open.state === 'in-flight' && !this.d.ledgerLookup(open.callId)) {
        open.state = 'no-charge';
        open.detail = 'the process ended before the proof was reserved; nothing was charged';
      }
      this.save(rec);
      if (open.state === 'in-flight') return { attempt: open, evaluation: this.evaluate('proof-in-flight: the proof call is still settling') };
      if (open.state === 'settled') return { attempt: open, evaluation: this.evaluate() };
    }

    const uncertain = rec.attempts.filter((a) => a.state === 'uncertain').length;
    if (uncertain >= GEMINI_PROOF_MAX_UNCERTAIN_ATTEMPTS) {
      return { attempt: null, evaluation: this.evaluate(`proof-attempts-exhausted: ${uncertain} proof calls ended uncertain; the door stays armed-pending-proof`) };
    }
    // On a multi-machine agent the ONE proof must be the forwarded one (check (e)): a
    // local proof would spend the slot on a row that can never satisfy the gate.
    if (this.d.multiMachine() && (opts.forwardedFrom === null || opts.forwardedFrom === this.d.selfMachineId)) {
      return { attempt: null, evaluation: this.evaluate('proof-must-be-forwarded: on a multi-machine agent, call POST /routing-spend/release-proof on another machine so the proof travels release-proof-forward') };
    }
    // (d) first: never spend on an unverified price.
    const model = this.d.modelsCheapestFirst().find((m) => this.d.modelVerified(m));
    if (!model) return { attempt: null, evaluation: this.evaluate() };
    const provider = this.d.provider();
    if (!provider) return { attempt: null, evaluation: this.evaluate('provider-unavailable: the Gemini door is not constructed on this machine') };

    const n = rec.attempts.length + 1;
    const callId = crypto.createHash('sha256').update(`gemini-payg-release-proof|${intentHash}|${n}`).digest('hex');
    const attempt: ProofAttempt = { n, callId, state: 'in-flight', modelId: model, at: new Date(this.now()).toISOString(), forwardedFrom: opts.forwardedFrom };
    rec.attempts.push(attempt);
    this.save(rec); // durable BEFORE the call: a crash mid-call resumes from the ledger
    try {
      const out = await provider.call({
        caller: 'release-proof',
        component: 'release-proof',
        model,
        prompt: GEMINI_PROOF_PROMPT,
        maxOutputTokens: GEMINI_PROOF_MAX_OUTPUT_TOKENS,
        callId,
        run: `release-proof:${intentHash.slice(0, 16)}`,
        proofMarker: mintReleaseProofMarker(this.d.door, intentHash),
      });
      attempt.reserveId = out.reserveId;
      attempt.costUsd = out.costUsd;
      this.resolveFromLedger(attempt);
      if (attempt.state === 'in-flight') attempt.state = 'settled';
    } catch (err) {
      attempt.detail = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      this.resolveFromLedger(attempt);
      // Nothing reserved (refused before the reservation) is a confirmed no-charge.
      if (attempt.state === 'in-flight') attempt.state = 'no-charge';
    }
    this.save(rec);
    return { attempt, evaluation: this.evaluate() };
  }

  /** Classify an attempt from its ledger row (the money ledger is the truth). */
  private resolveFromLedger(a: ProofAttempt): void {
    const v = this.d.ledgerLookup(a.callId);
    if (!v) return;
    a.reserveId = v.reserveId;
    a.ledgerDoor = v.door;
    // The priced door is read from the reserved price point; an id that does not name its
    // door leaves it unknown, and check (e) unmet (never compared with itself).
    a.pricedDoor = v.pricePointId && v.pricePointId.includes('|') ? v.pricePointId.split('|')[0] : undefined;
    if (v.state === 'reserved') { a.state = 'in-flight'; return; }
    if (v.state === 'provisional') { a.state = 'uncertain'; a.costUsd = v.contributionUsd; return; }
    if (v.state === 'expired') { a.state = v.contributionUsd > 0 ? 'uncertain' : 'no-charge'; return; }
    // settled
    if (v.contributionUsd === 0 && a.detail) { a.state = 'no-charge'; return; }
    a.state = a.detail ? 'uncertain' : 'settled';
    a.costUsd = v.contributionUsd;
  }

  /**
   * Evaluate the release checks in order; set `live` only when every check passes.
   * `extraBlocker` names a reason that pre-empts the checks (in-flight, exhausted).
   */
  evaluate(extraBlocker?: string, opts: { write?: boolean } = {}): ReleaseEvaluation {
    const intentHash = this.appliedIntentHash();
    const state = this.releaseState();
    if (!intentHash || state === 'not-armed') return { releaseState: 'not-armed', checks: [], blocker: 'not-armed' };
    const rec = this.load(intentHash);
    const checks: ReleaseCheck[] = [];
    const multi = this.d.multiMachine();

    const models = this.d.modelsCheapestFirst();
    const unverified = models.filter((m) => !this.d.modelVerified(m));
    checks.push({ id: 'd-prices-verified', ok: unverified.length === 0, detail: unverified.length ? `prices unverified: ${unverified.join(', ')}` : 'both prices verified' });

    const proof = rec.attempts.find((a) => a.state === 'settled');
    let proofOk = false;
    let proofDetail = 'no settled proof call yet';
    if (proof) {
      const doorsMatch = proof.ledgerDoor === this.d.door && proof.pricedDoor === this.d.door;
      const forwardOk = !multi || (proof.forwardedFrom !== null && proof.forwardedFrom !== this.d.selfMachineId);
      proofOk = doorsMatch && forwardOk;
      proofDetail = !doorsMatch
        ? `the proof row's doors disagree (door ${this.d.door}, ledger ${proof.ledgerDoor ?? '?'}, priced ${proof.pricedDoor ?? '?'})`
        : !forwardOk ? 'on a multi-machine agent the proof must arrive forwarded from another machine (release-proof-forward)' : `proof ${proof.reserveId} settled at $${(proof.costUsd ?? 0).toFixed(6)}`;
    }
    checks.push({ id: 'ae-proof-row', ok: proofOk, detail: proofDetail });

    const recon = this.d.reconciliation()?.hasRealBrowserRead() ?? false;
    checks.push({ id: 'c-reconciliation', ok: recon, detail: recon ? 'a browser-read reconciliation is recorded' : 'no browser-read reconciliation figure yet (unmeasurable does not count)' });

    if (multi) {
      let ok = false;
      let detail = 'no signed live-test PASS artifact recorded';
      if (rec.liveTest) {
        if (!this.d.verifyLiveTest) detail = 'the live-test artifact verifier is not available on this machine';
        else {
          const v = this.d.verifyLiveTest(rec.liveTest);
          ok = v.ok;
          detail = v.ok ? `live-test ${rec.liveTest.runId} verified` : `live-test artifact refused: ${v.reason ?? 'unverified'}`;
        }
      }
      checks.push({ id: 'b-live-test', ok, detail });
    }

    const firstUnmet = checks.find((c) => !c.ok);
    if (opts.write === false && !extraBlocker && !firstUnmet && state === 'armed-pending-proof') {
      return { releaseState: 'armed-pending-proof', checks, blocker: 'all-checks-pass: the next POST /routing-spend/release-proof records the release' };
    }
    if (extraBlocker || firstUnmet || state !== 'armed-pending-proof') {
      if (state === 'live') return { releaseState: 'live', checks, blocker: null };
      return { releaseState: 'armed-pending-proof', checks, blocker: extraBlocker ?? `${firstUnmet!.id}: ${firstUnmet!.detail}` };
    }
    // Every check passed: the ONE place `live` is set.
    try {
      this.d.capsStore()!.recordReleaseLive('release-proof-recorder', this.d.door, { proofReserveId: proof!.reserveId!, intentHash });
      rec.releasedAt = new Date(this.now()).toISOString();
      this.save(rec);
      return { releaseState: 'live', checks, blocker: null };
    } catch (err) {
      return { releaseState: 'armed-pending-proof', checks, blocker: `release-write-failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}` };
    }
  }

  /** The recorded proof attempts (for the caps view and the completion report). */
  attempts(): ProofAttempt[] {
    const ih = this.appliedIntentHash();
    return ih ? this.load(ih).attempts : [];
  }
}
