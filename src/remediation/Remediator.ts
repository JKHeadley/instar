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
import type {
  TrustElevationSource,
  RunbookTransition,
  CanTransitionContext,
} from './TrustElevationSource.js';
import type {
  ServerSupervisor,
  RegisteredRemediator,
  RestartRequestedPayload,
  RestartRequestedReply,
} from '../lifeline/ServerSupervisor.js';
import { signRemediationContext } from './RemediationContext.js';
import { subsystemInScope } from '../monitoring/probes/__shared.js';

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
  /**
   * §A3 capability-token HMAC over {attemptId, runbookId, expiresAt,
   * monotonicDeadline}, signed with the per-runbook capability leaf. The
   * surface MUST verify this via `verifyRemediationContext(ctx, keyVault)`
   * before treating the call as Remediator-authorized.
   *
   * Optional on the type so unit tests that only need the structural shape
   * (e.g. `RemediatorInvocationContext` in NativeModuleHealer) compile
   * without re-deriving signatures. Production paths always set it.
   */
  hmac?: Buffer;
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
  /**
   * F-5 trust-elevation source (Tier-2). When present, lifecycle-transition
   * methods (e.g. promote/un-quarantine) consult it before mutating runbook
   * state. Optional so existing Tier-1 tests + the Tier-1 dispatch path
   * continue to work without wiring the source.
   */
  trustSource?: TrustElevationSource;
  /**
   * F-6 supervisor handshake (Tier-2). When present, the Remediator
   * registers itself with the supervisor at construction and uses it to
   * issue planned restarts via `requestPlannedRestart()` below.
   */
  serverSupervisor?: ServerSupervisor;
  /**
   * §A52 probe-source registry. Maps `probeId` → declared verify-scope
   * (the list of subsystems the probe is allowed to report on) + the per-
   * probe leaf-key verifier. Events whose provenance is `'probe-id'`
   * MUST carry a signed envelope referencing a registered probe; events
   * referencing an unregistered probe are routed to `audit-rejected.jsonl`.
   *
   * Tier-3 wires the full fleet; F-8-rest accepts the registry shape so
   * one example probe (LifelineProbe) can flow end-to-end.
   */
  probeSourceRegistry?: ProbeSourceRegistry;
}

/**
 * §A40 + §A52 — per-probe authentication + scope binding. Probes that
 * emit `provenance: 'probe-id'` events MUST sign the envelope using their
 * `probe`-context leaf key. The Remediator verifies the signature, then
 * enforces that `event.subsystem ∈ scope` (the probe's declared
 * `__verifyScope`).
 */
export interface ProbeSourceRegistry {
  /**
   * Returns the declared verify-scope for the given probeId. An empty
   * scope means the probe has not been migrated to A52 enforcement
   * (Tier-3 fleet work) — its events will be routed to audit-rejected
   * on signed-probe-id flow.
   */
  getScope(probeId: string): ReadonlyArray<string>;
  /**
   * Verifies the signature on a probe-signed envelope. `probeId` selects
   * the leaf key (derived from the `probe`-context). `body` is the
   * canonical envelope bytes — see `canonicalProbeEnvelopeBody()` below.
   *
   * Returns `false` (never throws) for any verification failure: unknown
   * probe, length mismatch, HMAC mismatch.
   */
  verify(probeId: string, body: Buffer, signature: Buffer): boolean;
}

/**
 * §A40 probe-envelope signed payload. The probe emits this on the
 * `NormalizedDegradationEvent`'s `source.probeSignature` field (additive —
 * unset for legacy emit-sites and for non-probe provenances).
 */
export interface ProbeSignatureEnvelope {
  probeId: string;
  subsystem: string;
  outcome: string;
  reason: string;
  /** Monotonic timestamp (Number from performance.now()) at probe-side issuance. */
  monotonicTs: number;
  /** HMAC over `canonicalProbeEnvelopeBody(envelope)` using the probe leaf key. */
  signature: Buffer;
}

// ── Implementation ───────────────────────────────────────────────────────

export class Remediator implements RegisteredRemediator {
  private readonly opts: RemediatorOptions;
  private readonly runbooks = new Map<string, ApprovedRunbook>();
  /** Pending restart requestIds → resolver fns awaiting `onRestartComplete`. */
  private pendingRestartResolvers = new Map<string, (req: { requestId: string }) => void>();
  private lastRestartRequestRunbookId: string | null = null;

  constructor(opts: RemediatorOptions) {
    this.opts = opts;
    // F-6: register with supervisor at construction so the handshake file is
    // written before any restart-requested can fire. Idempotent — calling
    // registerRemediator twice with the same instance is a no-op.
    if (this.opts.serverSupervisor) {
      try {
        this.opts.serverSupervisor.registerRemediator(this);
      } catch (err) {
        // Supervisor registration is best-effort. A failure here means the
        // A15 alert-only fallback kicks in (Remediator-side fail-safe).
        console.error(
          `[Remediator] supervisor.registerRemediator failed: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── F-6: RegisteredRemediator interface ────────────────────────────────

  /**
   * Per-runbook capability leaf key used to sign `restart-requested`
   * payloads. The supervisor verifies via the SAME leaf because both sides
   * share the F-1 keyVault.
   */
  getCapabilityLeafKey(): Buffer {
    const lastRunbookId = this.lastRestartRequestRunbookId;
    return this.opts.keyVault.deriveLeafKey(
      'capability',
      lastRunbookId ?? '',
    );
  }

  /**
   * Supervisor → Remediator callback. Fires once per accepted
   * `restart-requested` after the server recovers. Resolves any pending
   * `requestPlannedRestart()` waiter.
   */
  onRestartComplete(req: { requestId: string }): void {
    const resolver = this.pendingRestartResolvers.get(req.requestId);
    if (resolver) {
      this.pendingRestartResolvers.delete(req.requestId);
      try {
        resolver(req);
      } catch (err) {
        console.error(
          `[Remediator] onRestartComplete resolver threw: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Issue a planned restart through the F-6 handshake. Signs the payload
   * with the capability leaf for `runbookId`, hands to the supervisor.
   * Returns the supervisor's reply.
   */
  async requestPlannedRestart(args: {
    runbookId: string;
    attemptId: string;
    blastRadius: BlastRadius;
  }): Promise<RestartRequestedReply | { accepted: false; reason: 'no-supervisor' }> {
    if (!this.opts.serverSupervisor) {
      return { accepted: false, reason: 'no-supervisor' };
    }
    const supervisor = this.opts.serverSupervisor;
    this.lastRestartRequestRunbookId = args.runbookId;

    const requestId = crypto.randomUUID();
    const handshakeVersion =
      typeof (supervisor as { getHandshakeProtocolVersion?: () => number })
        .getHandshakeProtocolVersion === 'function'
        ? (supervisor as { getHandshakeProtocolVersion: () => number })
            .getHandshakeProtocolVersion()
        : 1;
    const leaf = this.opts.keyVault.deriveLeafKey('capability', args.runbookId);
    const payloadBase: Omit<RestartRequestedPayload, 'hmac'> = {
      requestId,
      runbookId: args.runbookId,
      attemptId: args.attemptId,
      blastRadius: args.blastRadius,
      requestedAt: Date.now(),
      monotonicTs: process.hrtime.bigint(),
      handshakeVersion,
    };
    const { canonicalRestartRequestedBody } = await import(
      '../lifeline/ServerSupervisor.js'
    );
    const body = canonicalRestartRequestedBody(payloadBase as RestartRequestedPayload);
    const hmac = crypto.createHmac('sha256', leaf).update(body).digest();
    const payload: RestartRequestedPayload = { ...payloadBase, hmac };

    return supervisor.handleRestartRequested(payload);
  }

  /**
   * Consult the trust-elevation source for a lifecycle transition. When
   * `trustSource` is unset, the Remediator falls back to `{allowed: true,
   * reason: 'no-trust-source-wired'}` — Tier-1 behavior.
   */
  async canTransition(
    runbookId: string,
    transition: RunbookTransition,
    context: CanTransitionContext = {},
  ): Promise<{ allowed: boolean; reason: string }> {
    if (!this.opts.trustSource) {
      return { allowed: true, reason: 'no-trust-source-wired' };
    }
    return this.opts.trustSource.canTransition(runbookId, transition, context);
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
    // §A40 + §A52 — probe-source binding. When the event claims `provenance:
    // 'probe-id'` AND a probe registry is wired, the event MUST carry a
    // signed envelope and the declared scope MUST contain `event.subsystem`.
    // Unsigned / out-of-scope events route to audit-rejected.jsonl per A52.
    if (
      event.provenance === 'probe-id' &&
      this.opts.probeSourceRegistry
    ) {
      const registry = this.opts.probeSourceRegistry;
      const sig = event.source?.probeSignature;
      if (!sig || !sig.probeId || !Buffer.isBuffer(sig.signature)) {
        await this.auditAppendNoAttempt(
          'no-matching-runbook',
          event,
          /* runbookId */ undefined,
          /* coveredByAttemptId */ undefined,
          'probe-event-unsigned',
        );
        return { outcome: 'no-matching-runbook' };
      }
      const body = canonicalProbeEnvelopeBody(sig);
      if (!registry.verify(sig.probeId, body, sig.signature)) {
        await this.auditAppendNoAttempt(
          'no-matching-runbook',
          event,
          /* runbookId */ undefined,
          /* coveredByAttemptId */ undefined,
          'probe-signature-invalid',
        );
        return { outcome: 'no-matching-runbook' };
      }
      const scope = registry.getScope(sig.probeId);
      if (!subsystemInScope(scope, event.subsystem)) {
        await this.auditAppendNoAttempt(
          'no-matching-runbook',
          event,
          /* runbookId */ undefined,
          /* coveredByAttemptId */ undefined,
          'probe-subsystem-out-of-scope',
        );
        return { outcome: 'no-matching-runbook' };
      }
    }

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
    const expiresAt = issuedAt + matched.expectedRuntimeMs;
    const monotonicDeadline = issuedHrtime + expectedRuntimeNs;
    // §A3 — sign the capability token so the surface can verify Remediator
    // authority. Surfaces that don't verify (legacy paths) keep working;
    // surfaces that do verify (NativeModuleHealer.invokeFromRemediator) get
    // the timing-safe check at entry.
    const hmac = signRemediationContext(
      {
        attemptId,
        runbookId: matched.id,
        expiresAt,
        monotonicDeadline,
      },
      this.opts.keyVault,
    );
    const ctx: RemediationContext = {
      attemptId,
      runbookId: matched.id,
      lockHandle,
      auditToken,
      abortSignal: abortController.signal,
      expiresAt,
      monotonicDeadline,
      hmac,
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
    coveredByAttemptId?: string,
    redactedReasonOverride?: string,
  ): Promise<void> {
    const auditToken = this.opts.keyVault.deriveLeafKey('audit', null);
    const entry: AuditEntry = {
      entryId: crypto.randomUUID(),
      attemptId: coveredByAttemptId ?? `none:${crypto.randomUUID()}`,
      outcome,
      runbookId,
      subsystem: event.subsystem,
      reason: {
        redacted: redactedReasonOverride ?? event.reason.redacted,
      },
      errorCode: event.errorCode,
      timestamp: Date.now(),
      monotonicTs: process.hrtime.bigint(),
      auditToken,
    };
    await this.opts.auditWriter.append(entry);
  }
}

/**
 * §A40 canonical probe envelope serialization. Both the probe (signer) and
 * the Remediator (verifier) MUST agree on this byte layout exactly.
 *
 *   tag | probeId* | subsystem* | outcome* | reason* | monotonicTs(u64be)
 *
 *   * = uint32be length prefix followed by utf-8 body.
 */
export function canonicalProbeEnvelopeBody(
  env: Pick<
    ProbeSignatureEnvelope,
    'probeId' | 'subsystem' | 'outcome' | 'reason' | 'monotonicTs'
  >,
): Buffer {
  const tag = Buffer.from('instar-f8-probe-v1\x00', 'utf-8');
  const writeStr = (s: string): Buffer => {
    const body = Buffer.from(s, 'utf-8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    return Buffer.concat([len, body]);
  };
  const monoBuf = Buffer.alloc(8);
  monoBuf.writeBigUInt64BE(
    BigInt(Math.max(0, Math.floor(env.monotonicTs))),
    0,
  );
  return Buffer.concat([
    tag,
    writeStr(env.probeId),
    writeStr(env.subsystem),
    writeStr(env.outcome),
    writeStr(env.reason),
    monoBuf,
  ]);
}

/**
 * §A52 default `ProbeSourceRegistry` impl backed by a keyVault + a
 * `probeId → __verifyScope` map. Production callers wire one of these at
 * Remediator construction; tests can pass an inline stub.
 */
export class DefaultProbeSourceRegistry implements ProbeSourceRegistry {
  private readonly scopes: Map<string, ReadonlyArray<string>>;

  constructor(
    private readonly keyVault: Pick<RemediationKeyVault, 'deriveLeafKey'>,
    scopes: Record<string, ReadonlyArray<string>>,
  ) {
    this.scopes = new Map(Object.entries(scopes));
  }

  getScope(probeId: string): ReadonlyArray<string> {
    return this.scopes.get(probeId) ?? Object.freeze([]);
  }

  verify(probeId: string, body: Buffer, signature: Buffer): boolean {
    if (!this.scopes.has(probeId)) return false;
    let leaf: Buffer;
    try {
      leaf = this.keyVault.deriveLeafKey('probe', probeId);
    } catch {
      return false;
    }
    const expected = crypto.createHmac('sha256', leaf).update(body).digest();
    if (expected.length !== signature.length) return false;
    try {
      return crypto.timingSafeEqual(expected, signature);
    } catch {
      return false;
    }
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
