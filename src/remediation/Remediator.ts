/**
 * Remediator — Tier-1 orchestrator skeleton for the Self-Healing Remediator v2.
 *
 * SELF-HEALING-REMEDIATOR-V2-SPEC §A1 (F-8), §A2 (lock-bound co-existence),
 * §A3 (RemediationContext as capability token), §A4 (deadline enforcement),
 * §A6 (errorCode provenance — free-text rejected at registry-load),
 * §A21 (verify-failed strict typing — distinct from verify-inconclusive),
 * §A36 (essential-runbook validator), §A57 (Tier-1 subset).
 *
 * Scope of this PR (Tier-1 subset per A57):
 *   - Match incoming `NormalizedDegradationEvent` against registered runbooks
 *     using `eventPrefilter` (errorCode + provenance) and `match()`.
 *   - Acquire in-flight `MachineLock` keyed by `tupleHash = sha256(runbookId +
 *     signatureHash)`. Detect existing in-flight lock with same tuple →
 *     `covered-by-inline`.
 *   - Issue a `RemediationContext` carrying:
 *       - attemptId (uuid),
 *       - runbookId,
 *       - lockHandle (from MachineLock),
 *       - auditToken (leaf key from RemediationKeyVault, audit context),
 *       - abortSignal wired to deadline via AbortController,
 *       - expiresAt + monotonicDeadline.
 *   - Declare intent via IntentJournal.
 *   - Audit-append `started` + final outcome via AuditWriter.
 *   - Enforce `expectedRuntimeMs` deadline. surfaceCallable that hangs past the
 *     deadline trips the AbortController and yields `aborted-deadline`.
 *   - On surfaceCallable success → call `runbook.verify(ctx)` and audit the
 *     result with the verified taxonomy (A21).
 *   - On surfaceCallable failure → audit `verify-failed` without calling
 *     `verify()` (a failed surface cannot return a healthy outcome).
 *
 * Explicitly OUT of scope (Tier-2 per A57):
 *   - Trust elevation source.
 *   - Probe authentication.
 *   - Capability token HMAC enforcement on the surface side.
 *   - Supervisor handshake.
 *   - Runbook registry validation against a signed manifest.
 *
 * Audit-token issuance per call uses `RemediationKeyVault.deriveLeafKey('audit',
 * null)` (the audit context shares one machine-wide leaf per §A20). The actual
 * verification of that token happens inside `AuditWriter.append()`'s injected
 * `tokenVerifier` — the writer is the authority, the dispatcher merely issues.
 */

import crypto from 'node:crypto';
import type { NormalizedDegradationEvent } from '../monitoring/DegradationReporter.js';
import type { ErrorProvenance } from '../monitoring/ErrorCodeExtractor.js';
import type { RemediationKeyVault } from './RemediationKeyVault.js';
import type { MachineLock, InFlightHandle } from './MachineLock.js';
import type { IntentJournal } from './IntentJournal.js';
import type {
  AuditWriter,
  AuditOutcome,
  AuditEntry,
} from './audit/AuditWriter.js';

// ── Public types ─────────────────────────────────────────────────────────

export type BlastRadius = 'process' | 'machine' | 'fleet';
export type Reversibility = 'reversible' | 'irreversible';

export interface RemediationContext {
  attemptId: string;
  runbookId: string;
  lockHandle: InFlightHandle;
  auditToken: Buffer;
  abortSignal: AbortSignal;
  /** Wall-clock expiry (informational; the monotonic deadline is authoritative). */
  expiresAt: number;
  /** `process.hrtime.bigint()` at issuance + expectedRuntimeMs converted to ns. */
  monotonicDeadline: bigint;
}

export interface ExecutionResult {
  outcome: 'success' | 'failure';
  details: Record<string, unknown>;
}

export interface VerifyOutcome {
  outcome: 'verified-healthy' | 'verify-failed' | 'verify-inconclusive';
  reason: string;
}

export interface ApprovedRunbook {
  id: string;
  priority: number;
  surface: string;
  /**
   * §A6: provenance MUST NOT include `'free-text'`. Validator at
   * registerRunbook() refuses such matchers.
   */
  eventPrefilter: {
    errorCode: string[];
    provenance: ErrorProvenance[];
  };
  match: (event: NormalizedDegradationEvent) => boolean;
  preconditions: (event: NormalizedDegradationEvent) => Promise<boolean>;
  surfaceCallable: (ctx: RemediationContext) => Promise<ExecutionResult>;
  verify: (ctx: RemediationContext) => Promise<VerifyOutcome>;
  blastRadius: BlastRadius;
  reversibility: Reversibility;
  expectedRuntimeMs: number;
  /** §A36: only valid when blastRadius === 'machine'. */
  essential?: boolean;
}

export type DispatchOutcome =
  | { outcome: 'no-matching-runbook' }
  | { outcome: 'covered-by-inline'; existingAttemptId: string }
  | { outcome: 'verified-healthy'; attemptId: string }
  | { outcome: 'verify-failed'; attemptId: string }
  | { outcome: 'verify-inconclusive'; attemptId: string }
  | { outcome: 'aborted-deadline'; attemptId: string };

export interface RemediatorOptions {
  stateDir: string;
  keyVault: RemediationKeyVault;
  machineLock: MachineLock;
  intentJournal: IntentJournal;
  auditWriter: AuditWriter;
  /**
   * HMAC signer/verifier pair used to sign the in-flight lock envelope. In
   * production the dispatcher derives these from
   * `keyVault.deriveLeafKey('inflight', surfaceId)` per-runbook. Tests inject
   * a fixed pair for determinism. If omitted, the dispatcher derives the
   * pair at acquire-time using the keyVault's `inflight` context.
   */
  lockSigner?: (payload: Buffer) => Buffer;
  lockVerifier?: (payload: Buffer, signature: Buffer) => boolean;
}

// ── Implementation ───────────────────────────────────────────────────────

export class Remediator {
  private readonly opts: RemediatorOptions;
  private readonly runbooks = new Map<string, ApprovedRunbook>();

  constructor(opts: RemediatorOptions) {
    this.opts = opts;
  }

  /**
   * Register a runbook. Enforces §A6 (no free-text prefilter) and §A36
   * (essential ⇒ blastRadius === 'machine'). Rejection throws.
   */
  registerRunbook(runbook: ApprovedRunbook): void {
    if (!runbook.id) {
      throw new Error('Remediator.registerRunbook: runbook.id is required');
    }
    // §A6 — registry-load-time refusal of free-text prefilters.
    if (runbook.eventPrefilter.provenance.includes('free-text')) {
      throw new Error(
        `Remediator.registerRunbook: runbook "${runbook.id}" prefilter includes ` +
          `provenance 'free-text' (§A6 — structured sources only)`
      );
    }
    // §A36 — essential is only valid for machine-level blast-radius.
    if (runbook.essential === true && runbook.blastRadius !== 'machine') {
      throw new Error(
        `Remediator.registerRunbook: runbook "${runbook.id}" sets essential=true ` +
          `but blastRadius="${runbook.blastRadius}" (§A36 — essential requires 'machine')`
      );
    }
    if (this.runbooks.has(runbook.id)) {
      throw new Error(
        `Remediator.registerRunbook: runbook "${runbook.id}" already registered`
      );
    }
    this.runbooks.set(runbook.id, runbook);
  }

  /**
   * Dispatch a normalized degradation event. Resolves to a `DispatchOutcome`
   * describing the terminal state of the attempt (or the reason it never
   * started).
   *
   * Note: this method never throws on policy-level rejections; it returns a
   * structured outcome. It MAY throw on infrastructure failures (lock
   * acquisition error, audit write error not classified as token-rejected).
   */
  async dispatch(event: NormalizedDegradationEvent): Promise<DispatchOutcome> {
    const matched = this.matchRunbook(event);
    if (!matched) {
      await this.auditAppendNoAttempt(
        'no-matching-runbook',
        event,
        /* runbookId */ undefined
      );
      return { outcome: 'no-matching-runbook' };
    }

    const signatureHash = computeSignatureHash(event);
    const tupleHash = sha256Hex(`${matched.id}:${signatureHash}`);

    // §A2 — covered-by-inline check via existing in-flight lock.
    const inFlight = await this.opts.machineLock.listInFlight(
      this.opts.lockVerifier
    );
    const existing = inFlight.find((e) => e.tupleHash === tupleHash);
    if (existing) {
      await this.auditAppendNoAttempt(
        'covered-by-inline',
        event,
        matched.id,
        existing.attemptId
      );
      return {
        outcome: 'covered-by-inline',
        existingAttemptId: existing.attemptId,
      };
    }

    // Derive lock signer/verifier — either caller-provided (tests) or fresh
    // from the keyVault's `inflight` context for this surface.
    const { signer, verifier } = this.resolveLockKey(matched.surface);

    const attemptId = crypto.randomUUID();
    const lockHandle = await this.opts.machineLock.acquireInFlight({
      surfaceId: matched.surface,
      attemptId,
      tupleHash,
      expectedRuntimeMs: matched.expectedRuntimeMs,
      signer,
      verifier,
    });

    // Declare intent (durable witness) BEFORE running the surface.
    await this.opts.intentJournal.declareIntent({
      attemptId,
      runbookId: matched.id,
      signatureHash,
      blastRadius: matched.blastRadius,
      intent: 'dispatch',
    });

    // Build RemediationContext with deadline-wired AbortController (§A4).
    const abortController = new AbortController();
    const issuedAt = Date.now();
    const issuedHrtime = process.hrtime.bigint();
    const expectedRuntimeNs = BigInt(matched.expectedRuntimeMs) * 1_000_000n;
    const auditToken = this.opts.keyVault.deriveLeafKey('audit', null);
    const ctx: RemediationContext = {
      attemptId,
      runbookId: matched.id,
      lockHandle,
      auditToken,
      abortSignal: abortController.signal,
      expiresAt: issuedAt + matched.expectedRuntimeMs,
      monotonicDeadline: issuedHrtime + expectedRuntimeNs,
    };

    await this.auditAppend(
      'started',
      attemptId,
      matched.id,
      event,
      auditToken
    );

    // Deadline timer — fires AbortSignal at expectedRuntimeMs. The Tier-1
    // skeleton stops at the AbortSignal; child-process SIGTERM/SIGKILL
    // escalation is a surface-side concern (W-1 ships that).
    let deadlineTimer: NodeJS.Timeout | null = null;
    let deadlineFired = false;
    const deadlinePromise = new Promise<DispatchOutcome>((resolve) => {
      deadlineTimer = setTimeout(() => {
        deadlineFired = true;
        abortController.abort(new Error('Remediator: expectedRuntimeMs exceeded'));
        resolve({ outcome: 'aborted-deadline', attemptId });
      }, matched.expectedRuntimeMs);
      // Don't block process exit on the timer.
      if (typeof (deadlineTimer as { unref?: () => void }).unref === 'function') {
        (deadlineTimer as { unref: () => void }).unref();
      }
    });

    try {
      const racePromise: Promise<DispatchOutcome> = (async () => {
        let execResult: ExecutionResult;
        try {
          execResult = await matched.surfaceCallable(ctx);
        } catch (err) {
          if (deadlineFired) {
            // Surface threw because of the abort — let the deadline branch win.
            return { outcome: 'aborted-deadline', attemptId };
          }
          await this.auditAppend(
            'verify-failed',
            attemptId,
            matched.id,
            event,
            auditToken,
            {
              redacted: `surfaceCallable threw: ${redactErr(err)}`,
            }
          );
          return { outcome: 'verify-failed', attemptId };
        }

        if (deadlineFired) {
          return { outcome: 'aborted-deadline', attemptId };
        }

        if (execResult.outcome === 'failure') {
          await this.auditAppend(
            'verify-failed',
            attemptId,
            matched.id,
            event,
            auditToken,
            { redacted: 'surfaceCallable returned outcome=failure' }
          );
          return { outcome: 'verify-failed', attemptId };
        }

        // surfaceCallable succeeded — proceed to verify (§A21).
        let verifyOutcome: VerifyOutcome;
        try {
          verifyOutcome = await matched.verify(ctx);
        } catch (err) {
          // §A21 — verify probe error => verify-inconclusive (NOT verify-failed).
          await this.auditAppend(
            'verify-inconclusive',
            attemptId,
            matched.id,
            event,
            auditToken,
            { redacted: `verify threw: ${redactErr(err)}` }
          );
          return { outcome: 'verify-inconclusive', attemptId };
        }

        if (deadlineFired) {
          return { outcome: 'aborted-deadline', attemptId };
        }

        await this.auditAppend(
          verifyOutcome.outcome,
          attemptId,
          matched.id,
          event,
          auditToken,
          { redacted: verifyOutcome.reason }
        );
        return { outcome: verifyOutcome.outcome, attemptId };
      })();

      const result = await Promise.race([racePromise, deadlinePromise]);

      if (result.outcome === 'aborted-deadline') {
        await this.auditAppend(
          'aborted-deadline',
          attemptId,
          matched.id,
          event,
          auditToken,
          { redacted: `expectedRuntimeMs=${matched.expectedRuntimeMs} exceeded` }
        );
      }

      return result;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      try {
        await lockHandle.release();
      } catch {
        // Best-effort release — the stale-reclamation path will reclaim
        // if anything went wrong with the unlink.
      }
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private matchRunbook(
    event: NormalizedDegradationEvent
  ): ApprovedRunbook | undefined {
    // §A6 — events whose provenance is 'free-text' cannot match any runbook
    // even if the runbook somehow registered such a prefilter. We enforce at
    // registry-load (registerRunbook above), but defend in depth here too.
    if (event.provenance === 'free-text') return undefined;

    const candidates: ApprovedRunbook[] = [];
    for (const rb of this.runbooks.values()) {
      // errorCode prefilter — empty list means "no filter".
      if (
        rb.eventPrefilter.errorCode.length > 0 &&
        !rb.eventPrefilter.errorCode.includes(event.errorCode)
      ) {
        continue;
      }
      // provenance prefilter — empty list means "no filter".
      if (
        rb.eventPrefilter.provenance.length > 0 &&
        !rb.eventPrefilter.provenance.includes(event.provenance)
      ) {
        continue;
      }
      if (!rb.match(event)) continue;
      candidates.push(rb);
    }
    if (candidates.length === 0) return undefined;
    // Highest priority wins. Ties broken by id for deterministic ordering.
    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    });
    return candidates[0];
  }

  private resolveLockKey(surfaceId: string): {
    signer: (payload: Buffer) => Buffer;
    verifier: (payload: Buffer, signature: Buffer) => boolean;
  } {
    if (this.opts.lockSigner && this.opts.lockVerifier) {
      return { signer: this.opts.lockSigner, verifier: this.opts.lockVerifier };
    }
    const leaf = this.opts.keyVault.deriveLeafKey('inflight', surfaceId);
    return {
      signer: (payload) =>
        crypto.createHmac('sha256', leaf).update(payload).digest(),
      verifier: (payload, signature) => {
        const expected = crypto
          .createHmac('sha256', leaf)
          .update(payload)
          .digest();
        if (expected.length !== signature.length) return false;
        return crypto.timingSafeEqual(expected, signature);
      },
    };
  }

  private async auditAppend(
    outcome: AuditOutcome,
    attemptId: string,
    runbookId: string,
    event: NormalizedDegradationEvent,
    auditToken: Buffer,
    reasonOverride?: AuditEntry['reason']
  ): Promise<void> {
    const entry: AuditEntry = {
      entryId: crypto.randomUUID(),
      attemptId,
      outcome,
      runbookId,
      subsystem: event.subsystem,
      reason: reasonOverride ?? {
        redacted: event.reason.redacted,
        // intentionally NOT propagating event.reason.full into audit
        // projection — per §A14 the projection is a redacted read view.
      },
      timestamp: Date.now(),
      monotonicTs: process.hrtime.bigint(),
      auditToken,
    };
    await this.opts.auditWriter.append(entry);
  }

  private async auditAppendNoAttempt(
    outcome: AuditOutcome,
    event: NormalizedDegradationEvent,
    runbookId?: string,
    coveredByAttemptId?: string
  ): Promise<void> {
    const auditToken = this.opts.keyVault.deriveLeafKey('audit', null);
    const entry: AuditEntry = {
      entryId: crypto.randomUUID(),
      attemptId: coveredByAttemptId ?? `none:${crypto.randomUUID()}`,
      outcome,
      runbookId,
      subsystem: event.subsystem,
      reason: { redacted: event.reason.redacted },
      timestamp: Date.now(),
      monotonicTs: process.hrtime.bigint(),
      auditToken,
    };
    await this.opts.auditWriter.append(entry);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Stable signature hash over the structured fields of a normalized event.
 * Used for tuple keying + cross-process attempt ledger.
 *
 * Includes: subsystem, errorCode, provenance. Excludes timestamps and the
 * `reason` payload (which carries variable text). This is the same shape the
 * future cross-process ledger (A7) keys on; keeping the formula here keeps
 * F-8 and the ledger consistent without a shared helper module (which the
 * ledger PR is free to extract).
 */
function computeSignatureHash(event: NormalizedDegradationEvent): string {
  const canonical = JSON.stringify([
    event.subsystem,
    event.errorCode,
    event.provenance,
  ]);
  return sha256Hex(canonical);
}

function redactErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}
