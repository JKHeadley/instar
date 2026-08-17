/**
 * MoneyLayerEnableSurface — the orchestrator of the money-layer operator enable
 * surface (docs/specs/money-layer-operator-enable-surface.md, Phase 1).
 *
 * THIS OBJECT IS CONSTRUCTED UNCONDITIONALLY, unlike the money layer it
 * governs. That is the whole point: the six routes it serves are PRE-GATE —
 * they must work while the money layer is off, because they are the door to
 * turning it on. A surface constructed only when the thing it enables is
 * already enabled would be a switch inside the locked room.
 *
 * It owns: the durable operator flag, the lifecycle derivation, its own
 * pre-gate plan store, the restart-nonce mint, the two audit channels, and the
 * rate limits / PIN lockout. It does NOT own the money layer's components — it
 * observes whether they were constructed and probes them.
 */

import crypto from 'node:crypto';
import { MoneyLayerEnableStore } from './MoneyLayerEnableStore.js';
import { MoneyLayerAuditLog, filterRowsForPregate, type MoneyAuditRow } from './MoneyLayerAuditLog.js';
import { RenderedPlanStore, PlanCommitError, type RenderedPlan } from './RenderedPlanStore.js';
import {
  MONEY_LAYER_PREGATE_ACTIONS,
  isMoneyLayerPregateAction,
  resolveEnableSources,
  resolveIntentEnabled,
  deriveLifecycleState,
  resolveServingReady,
  isRestartEligible,
  disableActionFor,
  type EnableSources,
  type MoneyLayerPregateAction,
  type MoneyLifecycleState,
} from './moneyLayerEnable.js';
import { runCapGateProbe, type ProbeAdmitLike, type ProbeSettleLike, type ProbeVerdict } from './moneyLayerProbe.js';
import type { CapsStoreFile } from './RoutingSpendCapsStore.js';

/** Shipped defaults for the rate limits (§2), so tests and abuse analysis are not fuzzy. */
export const MONEY_LAYER_LIMIT_DEFAULTS = {
  planRenderPerHour: 20,
  planTtlSeconds: 600,
  restartNonceTtlSeconds: 120,
  restartCooldownSeconds: 60,
  pinFailuresBeforeLockout: 5,
  pinLockoutSeconds: 900,
} as const;

export type MoneyLayerLimits = { -readonly [K in keyof typeof MONEY_LAYER_LIMIT_DEFAULTS]: number };

export interface MoneyLayerStatus {
  lifecycleState: MoneyLifecycleState;
  /** IDENTICAL to servingReady by definition — never a proxy for it (MLE-2). */
  enforcementReady: boolean;
  enableSources: EnableSources;
  configSnapshotAt: string | null;
  machineId: string;
  machineNickname: string | null;
  lastTransitionAt: string | null;
  failingComponent?: string;
  settlingCount: number;
  restartEligible: boolean;
  anyKeyFrozen: boolean;
  freezeRecordProvisional: boolean;
}

export interface MoneyLayerEnableSurfaceDeps {
  store: MoneyLayerEnableStore;
  audit: MoneyLayerAuditLog;
  machineId: string;
  machineNickname?: string | null;
  /** The config half of MLE-1, read from the PROCESS SNAPSHOT — never re-read from disk per call. */
  configEnabled: () => boolean;
  /** When the process's config snapshot was taken, so a config-derived claim is never shown without its age. */
  configSnapshotAt: () => string | null;
  /** Were the money-layer components constructed in THIS process? */
  componentsConstructed: () => boolean;
  /** The constructed gate, for the probe. Null when construction did not happen or failed. */
  gate: () => ProbeAdmitLike | null;
  /** A caps snapshot for the probe's preconditions, or null when unreadable. */
  capsSnapshot: () => CapsStoreFile | null;
  /**
   * The ledger, so the probe can UNDO the booking an unexpectedly-admitted
   * over-cap reservation would create (second-pass finding 8). Optional: absent,
   * an admit is still reported as the loud failure it is — just without the
   * compensating settle.
   */
  ledger?: () => ProbeSettleLike | null;
  /** Live single-instance-lock ownership. MLE-2: a lost lock fails closed. */
  lockHeld: () => boolean;
  /** In-flight calls/reservations still settling — DERIVED from the ledger, never an independent counter. */
  settlingCount: () => number;
  limits?: Partial<MoneyLayerLimits>;
  now?: () => number;
}

export class MoneyLayerRefusal extends Error {
  constructor(
    public status: 400 | 401 | 409 | 429 | 503,
    public code: string,
    msg: string,
  ) {
    super(msg);
    this.name = 'MoneyLayerRefusal';
  }
}

interface RestartNonceRecord {
  nonce: string;
  confirmationText: string;
  confirmationTextHash: string;
  expiresAt: number;
  consumed: boolean;
}

export class MoneyLayerEnableSurface {
  private readonly d: MoneyLayerEnableSurfaceDeps;
  private readonly now: () => number;
  private readonly limits: MoneyLayerLimits;
  /** The PRE-GATE plan store — separate from the money layer's own, because it must exist while that layer does not. */
  private readonly plans: RenderedPlanStore;
  /** planId → the render-time facts commit must re-check (§2: state-at-render, machine, lock). */
  private readonly renderContext = new Map<string, { sourceState: string; machineId: string; renderedUnderLock: boolean; renderedTextHash: string }>();
  private restartNonce: RestartNonceRecord | null = null;
  private lastAcceptedRestartAt = 0;
  private planRenderTimes: number[] = [];
  private pinFailures: number[] = [];
  private lockoutUntil = 0;
  /** The probe outcome for THIS process. Null until a probe has run — an unmeasured probe is not a pass. */
  private probeResult: { passed: boolean; failingComponent?: string } | null = null;
  private freezeRecordProvisional = false;

  constructor(deps: MoneyLayerEnableSurfaceDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
    this.limits = { ...MONEY_LAYER_LIMIT_DEFAULTS, ...(deps.limits ?? {}) };
    this.plans = new RenderedPlanStore({ now: this.now, ttlMs: this.limits.planTtlSeconds * 1000 });
  }

  // ── State ────────────────────────────────────────────────────────

  /**
   * Recompute `enableSources` from the CURRENT process snapshot. Does NOT force
   * a config reload — forcing a disk re-read per status poll would be a disk hit
   * on a polled route to chase a value this spec already says is not an
   * immediate control. The STORE half IS live.
   */
  enableSources(): EnableSources {
    return resolveEnableSources(this.d.store.operatorEnabled(), this.d.configEnabled() === true);
  }

  /**
   * The full status. READ-ONLY: no audit append, no `lastObservedSourceState`
   * update, no nonce mint (T32). Making a polled GET capable of audit writes
   * would both contradict its contract and let dashboard polling drive log
   * volume.
   */
  status(): MoneyLayerStatus {
    const sources = this.enableSources();
    const intentEnabled = resolveIntentEnabled(sources);
    const stored = this.readStoreSafe();
    const derived = deriveLifecycleState({
      intentEnabled,
      componentsConstructed: this.d.componentsConstructed(),
      probe: this.probeResult,
      storedFailure: stored?.failure ?? null,
    });
    const lockHeld = this.d.lockHeld();
    const enforcementReady = resolveServingReady({ intentEnabled, lifecycleState: derived.lifecycleState, singleInstanceLockHeld: lockHeld });
    const caps = this.d.capsSnapshot();
    return {
      lifecycleState: derived.lifecycleState,
      enforcementReady,
      enableSources: sources,
      configSnapshotAt: this.d.configSnapshotAt(),
      machineId: this.d.machineId,
      machineNickname: this.d.machineNickname ?? null,
      lastTransitionAt: stored?.lastTransitionAt ?? null,
      ...(derived.failingComponent ? { failingComponent: derived.failingComponent } : {}),
      settlingCount: this.safeSettlingCount(),
      restartEligible: isRestartEligible(derived.lifecycleState),
      anyKeyFrozen: caps ? Object.values(caps.caps).some((c) => c.frozen) : false,
      freezeRecordProvisional: this.freezeRecordProvisional,
    };
  }

  /**
   * `servingReady` — the ONE predicate the paid path consults. Exposed so the
   * metered path calls exactly this rather than reconstructing it, which is
   * what makes `enforcementReady === servingReady` true by construction rather
   * than by discipline.
   */
  servingReady(): boolean {
    const sources = this.enableSources();
    const intentEnabled = resolveIntentEnabled(sources);
    const stored = this.readStoreSafe();
    const { lifecycleState } = deriveLifecycleState({
      intentEnabled,
      componentsConstructed: this.d.componentsConstructed(),
      probe: this.probeResult,
      storedFailure: stored?.failure ?? null,
    });
    return resolveServingReady({ intentEnabled, lifecycleState, singleInstanceLockHeld: this.d.lockHeld() });
  }

  // ── Boot ─────────────────────────────────────────────────────────

  /**
   * Run at money-layer construction (boot). This is a MUTATING path, so it is
   * one of the two places allowed to observe an enable-source transition and
   * append its row.
   */
  async onBoot(): Promise<void> {
    const sources = this.enableSources();
    this.observeSourceTransition(sources, 'boot');
    if (!resolveIntentEnabled(sources)) return;

    if (!this.d.componentsConstructed()) {
      // enable-pending-restart, or the stored failure — deriveLifecycleState decides.
      this.auditOnly('lifecycle-transition', 'boot', { to: this.status().lifecycleState });
      return;
    }
    await this.runProbe('boot');
    const s = this.status();
    this.auditOnly('lifecycle-transition', 'boot', { to: s.lifecycleState, failingComponent: s.failingComponent });
    if (s.enforcementReady) {
      // Written by the NEW process after its probe — the only durable proof a
      // restart achieved anything (§4).
      this.auditOnly('restart-observed-ready', 'boot', { machineId: this.d.machineId });
    }
  }

  /**
   * Run the cap-gate probe and record its verdict. The stored failure record is
   * cleared ONLY by a probe that actually passes — never by the attempt itself,
   * so a repeatedly-failing layer keeps reporting the same honest failure.
   */
  async runProbe(actor: string): Promise<ProbeVerdict> {
    const gate = this.d.gate();
    if (!gate) {
      const verdict: ProbeVerdict = { passed: false, failingComponent: 'gate-not-constructed', refusalReason: null };
      this.probeResult = { passed: false, failingComponent: verdict.failingComponent };
      this.recordFailureSafe('construction-failed', verdict.failingComponent);
      this.auditOnly('probe-result', actor, { passed: false, failingComponent: verdict.failingComponent });
      return verdict;
    }
    let verdict: ProbeVerdict;
    try {
      verdict = await runCapGateProbe(gate, this.d.capsSnapshot(), this.d.ledger?.() ?? null);
    } catch (err) {
      // Unmeasurable ⇒ unknown ⇒ NOT ready (P20).
      verdict = { passed: false, failingComponent: `probe-threw:${String(err)}`, refusalReason: null };
    }
    if (verdict.passed) {
      this.probeResult = { passed: true };
      this.clearFailureSafe();
    } else {
      this.probeResult = { passed: false, failingComponent: verdict.failingComponent };
      this.recordFailureSafe('probe-failed', verdict.failingComponent);
    }
    this.auditOnly('probe-result', actor, {
      passed: verdict.passed,
      ...(verdict.passed ? { refusalReason: verdict.refusalReason, evaluatedUsd: verdict.evaluatedUsd } : { failingComponent: verdict.failingComponent }),
    });
    return verdict;
  }

  // ── Plan rendering ───────────────────────────────────────────────

  /**
   * Render a canonical plan. REQUIRES the single-instance lock, unlike the other
   * audit-only pre-gate routes: a rendered plan is not an authority write, but it
   * IS authorization material — a planId/nonce later spendable with the PIN — so
   * minting it from a non-owner process would let a non-owner manufacture the
   * artifact the commit path trusts (T38).
   */
  renderPlan(action: unknown): { planId: string; nonce: string; renderedText: string; action: MoneyLayerPregateAction; sourceStateAtRender: string; machineId: string; machineNickname: string | null; expiresAt: string } {
    if (!isMoneyLayerPregateAction(action)) {
      // SYNTAX: this string never named a real pre-gate action.
      throw new MoneyLayerRefusal(400, 'unknown-action', `action must be one of: ${MONEY_LAYER_PREGATE_ACTIONS.join(', ')}`);
    }
    if (!this.d.lockHeld()) {
      throw new MoneyLayerRefusal(409, 'lock-not-held', 'plan rendering requires the single-instance lock — this process is not the owner');
    }
    this.enforcePlanRenderRate();

    const sources = this.enableSources();
    // SECOND-PASS FINDING 2 — `money-layer-mirror-config` renders text saying it
    // COPIES the config setting and "changes nothing about what may currently
    // spend". With the config key OFF there is nothing to copy, and the commit
    // would still write `operatorEnabled = true` — creating durable enable
    // intent behind text that promised no change. That is precisely the
    // approved-text-vs-applied-action gap plan-binding exists to close, so the
    // action is refused where its own text would be false.
    if (action === 'money-layer-mirror-config' && !sources.config) {
      throw new MoneyLayerRefusal(
        409,
        'nothing-to-mirror',
        'the config file is not enabling the money layer, so there is nothing to mirror into the operator store — use money-layer-enable if you mean to turn it on',
      );
    }
    let effective: MoneyLayerPregateAction = action;
    if (action === 'money-layer-disable') {
      // The renderer REFUSES plain disable while the config key is set and
      // renders the acknowledged variant in its place (§5).
      effective = disableActionFor(sources);
    }
    const renderedText = this.renderText(effective, sources);
    const plan = this.plans.render(effective, renderedText, { moneyLayerAction: effective }, {});
    this.renderContext.set(plan.planId, {
      sourceState: sources.state,
      machineId: this.d.machineId,
      renderedUnderLock: true,
      renderedTextHash: sha256(renderedText),
    });
    this.auditOnly('plan-rendered', 'operator', {
      planId: plan.planId,
      action: effective,
      requestedAction: action,
      sourceStateAtRender: sources.state,
      machineId: this.d.machineId,
      renderedTextHash: sha256(renderedText),
    });
    return {
      planId: plan.planId,
      nonce: plan.nonce,
      renderedText,
      action: effective,
      sourceStateAtRender: sources.state,
      machineId: this.d.machineId,
      machineNickname: this.d.machineNickname ?? null,
      expiresAt: new Date(plan.expiresAt).toISOString(),
    };
  }

  /** The operator approves the SERVER's words. Every string a commit can apply is authored here. */
  private renderText(action: MoneyLayerPregateAction, sources: EnableSources): string {
    const where = `on machine '${this.d.machineNickname ?? this.d.machineId}'`;
    switch (action) {
      case 'money-layer-enable':
        return (
          `Turn ON the spending-control layer ${where}. ` +
          `This records your decision and the layer comes up on the next server restart — it is NOT enforcing yet, and this restarts nothing now. ` +
          `It arms NO paid service: every door stays refused with $0 committed until you separately arm it with your PIN.`
        );
      case 'money-layer-mirror-config':
        return (
          `Copy the config-file setting into the operator store ${where}, so the spending-control layer stays on if that file changes. ` +
          `This does NOT clear the config-file setting, and it changes nothing about what may currently spend.`
        );
      case 'money-layer-disable':
        return (
          `Turn OFF the spending-control layer ${where} by clearing the operator setting. ` +
          `New paid calls are refused from the next call onward. Calls already in flight with a provider finish and their spend IS recorded. ` +
          `This does not restart the server.`
        );
      case 'money-layer-disable-store-only':
        return (
          `THIS WILL NOT STOP SPENDING. ${where}, the spending-control layer is ALSO switched on by a setting in the config file, ` +
          `and this action clears only the operator setting — the config file's setting remains and the layer stays enabled. ` +
          `To stop spending now, use FREEZE. To make the config file's setting take effect as changed, edit it and restart. ` +
          `Current source: ${sources.state}.`
        );
    }
  }

  // ── Commit ───────────────────────────────────────────────────────

  /**
   * PIN-gated commit. The action comes from the STORED PLAN, never the request
   * body — so the pre-gate door cannot be walked through with a validly-signed
   * caps-adjust plan.
   */
  async commit(args: { pin: string; planId: unknown; nonce: unknown; pinValid: boolean }): Promise<{
    lifecycleState: MoneyLifecycleState;
    enforcementReady: boolean;
    enableSources: EnableSources;
    storeCleared: boolean;
    probe: ProbeVerdict | null;
    message: string;
  }> {
    if (!this.checkPin(args.pinValid, 'commit')) {
      throw new MoneyLayerRefusal(401, 'bad-pin', 'PIN rejected');
    }
    if (typeof args.planId !== 'string' || typeof args.nonce !== 'string') {
      throw new MoneyLayerRefusal(400, 'malformed', 'planId and nonce are required strings');
    }
    const ctx = this.renderContext.get(args.planId);
    if (!ctx) {
      throw new MoneyLayerRefusal(409, 'unknown-plan', 'no such plan on this machine — render one first');
    }
    // An unaudited render is structurally unusable, not merely discouraged (T38).
    if (!ctx.renderedUnderLock) {
      throw new MoneyLayerRefusal(409, 'render-not-under-lock', 'this plan was rendered without the single-instance lock and cannot be committed');
    }
    if (ctx.machineId !== this.d.machineId) {
      throw new MoneyLayerRefusal(409, 'wrong-machine', `this plan was rendered for machine '${ctx.machineId}', not '${this.d.machineId}'`);
    }

    let plan: RenderedPlan;
    try {
      plan = this.plans.commit(args.planId, args.nonce, {});
    } catch (err) {
      if (err instanceof PlanCommitError) throw new MoneyLayerRefusal(409, err.code, err.message);
      throw err;
    }
    const action = plan.fields.moneyLayerAction;
    // The commit route rejects any plan whose SIGNED action is not on the
    // pre-gate allowlist, BEFORE any effect — without this, the pre-gate commit
    // route would accept any valid plan id, including a caps-adjust plan (T1b/T2).
    if (!isMoneyLayerPregateAction(action)) {
      throw new MoneyLayerRefusal(409, 'action-not-pregate', `plan action '${String(action)}' is not a money-layer pre-gate action`);
    }
    // The operator approves a decision made in a particular situation; if the
    // situation moved, they should see the new plan (T25).
    const sourcesNow = this.enableSources();
    if (sourcesNow.state !== ctx.sourceState) {
      throw new MoneyLayerRefusal(409, 'source-state-drift', `the enable-source state changed since this plan was rendered (${ctx.sourceState} → ${sourcesNow.state}) — re-render`);
    }
    if (!this.d.lockHeld()) {
      // An authority write refused because auditing is what is refused: the
      // failure goes to the ORDINARY server log marked non-authoritative (T26).
      console.error(`[money-layer NON-AUTHORITATIVE] commit '${action}' REFUSED — single-instance lock not held by this process`);
      throw new MoneyLayerRefusal(409, 'lock-not-held', 'this process does not hold the single-instance lock — money authority writes are refused');
    }

    return this.applyAction(action, plan.renderedText, ctx.renderedTextHash);
  }

  private async applyAction(action: MoneyLayerPregateAction, renderedText: string, renderedTextHash: string): Promise<{
    lifecycleState: MoneyLifecycleState;
    enforcementReady: boolean;
    enableSources: EnableSources;
    storeCleared: boolean;
    probe: ProbeVerdict | null;
    message: string;
  }> {
    let storeCleared = false;
    let probe: ProbeVerdict | null = null;
    let message: string;
    const before = this.status();

    if (action === 'money-layer-enable' || action === 'money-layer-mirror-config') {
      // Idempotent in INTENT — it never double-enables — but always re-verifies
      // and re-repairs. "Switch on, machinery down" is exactly the state this
      // control exists to rescue the operator from.
      // SECOND-PASS FINDING 4 — the authority record is appended BEFORE the
      // store write, not after. "Money state never changes without its record"
      // is only true in this order: a throwing append leaves the store
      // untouched, whereas the previous order left the enable landed and then
      // errored. A record without its change is the safe asymmetry (it
      // over-reports an attempt); a change without its record is not.
      this.authority(action === 'money-layer-enable' ? 'enable-committed' : 'mirror-config-committed', 'operator', {
        renderedTextHash,
        machineId: this.d.machineId,
      });
      this.d.store.setOperatorEnabled(true);
      if (before.lifecycleState === 'construction-failed' || !this.d.componentsConstructed()) {
        // Phase 1 does NOT construct hot: nothing a commit does can fix this.
        // Say so, and never pretend to have probed (T12b).
        message =
          before.lifecycleState === 'construction-failed'
            ? 'the spending-control layer could not be built on this machine — a server restart is required; nothing was probed'
            : 'enabled — the money layer comes up on the next server restart; it is not enforcing yet';
      } else {
        // Components exist, so an enable CAN re-probe.
        probe = await this.runProbe('operator');
        message = probe.passed
          ? 'spending controls are up and enforcing'
          : `the spending controls are not enforcing yet (${probe.failingComponent}) — a server restart is the remedy`;
      }
    } else {
      // Disable clears the STORE flag ONLY. No route here writes the config file.
      // Record-before-mutate, same reasoning as the enable path above.
      this.authority('disable-committed', 'operator', { renderedTextHash, machineId: this.d.machineId, storeOnly: action === 'money-layer-disable-store-only' });
      this.d.store.setOperatorEnabled(false);
      storeCleared = true;
      const after = this.enableSources();
      message = after.config
        ? 'the operator setting is cleared, but the layer is STILL ENABLED by the config file — this did not stop spending. Use freeze to stop it now.'
        : `disabled — new paid calls are refused from the next call onward${this.safeSettlingCount() > 0 ? `; ${this.safeSettlingCount()} call(s) are still settling` : ''}`;
    }

    // The commit's POST-VERIFY step: the second of the two mutating paths
    // allowed to observe an enable-source transition (MLE-1).
    const sourcesAfter = this.enableSources();
    this.observeSourceTransition(sourcesAfter, 'commit');
    const after = this.status();
    if (after.lifecycleState !== before.lifecycleState) {
      this.auditOnly('lifecycle-transition', 'operator', { from: before.lifecycleState, to: after.lifecycleState });
    }
    void renderedText;
    return {
      lifecycleState: after.lifecycleState,
      enforcementReady: after.enforcementReady,
      enableSources: sourcesAfter,
      storeCleared,
      probe,
      message,
    };
  }

  // ── Restart ──────────────────────────────────────────────────────

  /**
   * Mint the single-use restart nonce. Succeeds ONLY in the three restartable
   * states, so the surface cannot offer a restart the route would refuse.
   *
   * WHAT THE HASH PROVES, stated exactly: the caller possessed the canonical
   * text — NOT that a human read it. It is a client-integrity check, not an
   * operator-consent proof, and must never be cited as the latter. The consent
   * evidence for restart is the PIN.
   */
  mintRestartNonce(): { nonce: string; expiresAt: string; confirmationText: string } {
    const s = this.status();
    if (!isRestartEligible(s.lifecycleState)) {
      throw new MoneyLayerRefusal(409, 'not-restartable', `restart is only accepted in enable-pending-restart, probe-failed or construction-failed (state: ${s.lifecycleState})`);
    }
    const confirmationText =
      `This RESTARTS THE WHOLE AGENT SERVER on machine '${this.d.machineNickname ?? this.d.machineId}' — not just the spending-control layer. ` +
      `Unrelated work on this machine is interrupted: in-flight non-money work, local agent sessions and any open dashboard connection. ` +
      `It is how the spending-control layer comes up after being switched on.`;
    const nonce = crypto.randomBytes(16).toString('hex');
    this.restartNonce = {
      nonce,
      confirmationText,
      confirmationTextHash: sha256(confirmationText),
      expiresAt: this.now() + this.limits.restartNonceTtlSeconds * 1000,
      consumed: false,
    };
    return { nonce, expiresAt: new Date(this.restartNonce.expiresAt).toISOString(), confirmationText };
  }

  /**
   * Validate a restart request. Returns when it is accepted; the CALLER performs
   * the supervised-restart handoff, and must `await audit.flush()` first —
   * `restart requested` is appended and FLUSHED BEFORE the handoff, so a process
   * that exits mid-restart still records that the operator asked.
   */
  acceptRestart(args: { pinValid: boolean; nonce: unknown; confirmationTextHash: unknown; force?: boolean }): void {
    if (!this.checkPin(args.pinValid, 'restart')) {
      throw new MoneyLayerRefusal(401, 'bad-pin', 'PIN rejected');
    }
    const s = this.status();
    if (!isRestartEligible(s.lifecycleState)) {
      this.auditOnly('pin-attempt-failed', 'operator', { route: 'restart', reason: 'not-restartable', state: s.lifecycleState });
      throw new MoneyLayerRefusal(409, 'not-restartable', `restart is refused in state '${s.lifecycleState}'`);
    }
    const rec = this.restartNonce;
    if (!rec || rec.consumed || this.now() > rec.expiresAt || typeof args.nonce !== 'string' || !timingSafeEqualStr(args.nonce, rec.nonce)) {
      throw new MoneyLayerRefusal(409, 'stale-nonce', 'restart nonce is unknown, consumed or expired — re-read status and mint a fresh one');
    }
    // A client that never fetched the text cannot produce the hash (T39).
    if (typeof args.confirmationTextHash !== 'string' || !timingSafeEqualStr(args.confirmationTextHash, rec.confirmationTextHash)) {
      throw new MoneyLayerRefusal(409, 'confirmation-hash-mismatch', 'confirmationTextHash is absent or does not match the text minted with this nonce');
    }
    const lastAccepted = Math.max(this.lastAcceptedRestartAt, this.readStoreSafe()?.lastRestartAcceptedAtMs ?? 0);
    const sinceLast = this.now() - lastAccepted;
    if (lastAccepted > 0 && sinceLast < this.limits.restartCooldownSeconds * 1000) {
      throw new MoneyLayerRefusal(429, 'restart-cooldown', `a restart was accepted ${Math.round(sinceLast / 1000)}s ago — the cooldown is ${this.limits.restartCooldownSeconds}s`);
    }
    const settling = this.safeSettlingCount();
    if (settling > 0 && args.force !== true) {
      throw new MoneyLayerRefusal(409, 'money-settling', `${settling} paid call(s) are still settling — re-send with force:true to restart anyway`);
    }
    rec.consumed = true; // single-use: a second presentation is refused (T27)
    // SECOND-PASS FINDING 7 — an in-memory-only timestamp is no cooldown at all
    // HERE, because the action being rate-limited is the one that ends this
    // process: every restart reset the clock, so a persistently-failing layer
    // could be restart-looped without limit. It is persisted so the NEW process
    // inherits it.
    this.lastAcceptedRestartAt = this.now();
    try {
      this.d.store.recordRestartAccepted(this.now());
    } catch (err) {
      console.error(`[money-layer] could not persist the restart cooldown: ${String(err)}`);
    }
    // SECOND-PASS FINDING 5 — `settlingAtRequest` was a COUNT OF IN-FLIGHT PAID
    // CALLS on a row the pre-gate filter shows in full, which leaked exactly the
    // spend activity the sensitivity split withholds. The row records only
    // whether the operator forced past a settling refusal, never how many.
    this.auditOnly('restart-requested', 'operator', { machineId: this.d.machineId, state: s.lifecycleState, forced: args.force === true });
  }

  /** Best-effort by contract: its ABSENCE must never be read as "never tried" (§4). */
  noteRestartInitiated(): void {
    try {
      this.auditOnly('restart-initiated', 'operator', { machineId: this.d.machineId });
    } catch {
      // @silent-fallback-ok: explicitly best-effort; the flushed `restart-requested` row is the durable evidence.
    }
  }

  // ── Freeze bookkeeping ───────────────────────────────────────────

  /**
   * Record a freeze. THE NAMED EXCEPTION to audit coupling (§7): the marker
   * write is authoritative and proceeds; this row is best-effort. Refusing a
   * freeze because its row could not be written would let a logging failure
   * disable the emergency stop.
   *
   * Returns FALSE when the operator must be told the record is provisional.
   */
  recordFreeze(keyRef: string, caller: string, reason: string): boolean {
    const ok = this.d.audit.appendBestEffort('freeze', caller, { keyRef, caller, reason });
    if (!ok) this.freezeRecordProvisional = true;
    return ok;
  }

  /** Unfreeze is NOT excepted: no record, no resumption (T36). */
  recordUnfreeze(keyRef: string, caller: string, reason: string): void {
    this.d.audit.authority().append('unfreeze', caller, { keyRef, caller, reason });
  }

  // ── Audit reads ──────────────────────────────────────────────────

  /**
   * The merged, time-ordered history. Sensitivity filtering happens BEFORE
   * pagination, and the returned totals describe the FILTERED set only —
   * otherwise a pre-gate reader could infer the volume and timing of hidden rows
   * from gaps in the sequence (§2).
   */
  readAuditLog(args: { pregateOnly: boolean; limit?: number }): { rows: MoneyAuditRow[]; total: number; filtered: boolean } {
    const all = this.d.audit.readAll();
    const visible = args.pregateOnly ? filterRowsForPregate(all) : all;
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 500) : 100;
    return { rows: visible.slice(-limit), total: visible.length, filtered: args.pregateOnly };
  }

  // ── Internals ────────────────────────────────────────────────────

  private observeSourceTransition(sources: EnableSources, actor: string): void {
    try {
      const previous = this.d.store.observeSourceState(sources.state);
      if (previous !== null) {
        this.auditOnly('enable-source-transition', actor, { from: previous, to: sources.state });
      }
    } catch (err) {
      console.error(`[money-layer] could not record an enable-source transition: ${String(err)}`);
    }
  }

  private auditOnly(type: Parameters<ReturnType<MoneyLayerAuditLog['auditOnly']>['append']>[0], actor: string, detail: Record<string, unknown>): void {
    try {
      this.d.audit.auditOnly().append(type, actor, detail);
    } catch (err) {
      // @silent-fallback-ok: NOT silent — it logs with the row type. Proceeding
      // is deliberate per §7: only AUTHORITY writes are coupled to a trusted
      // append, and refusing a read because its audit row failed would be a
      // self-inflicted outage for no safety gain.
      // A NON-authority append failure lets the operation proceed and is
      // reported — refusing a read would be a self-inflicted outage for no
      // safety gain (§7).
      console.error(`[money-layer] audit-only append failed (${type}): ${String(err)}`);
    }
  }

  /** An AUTHORITY append is COUPLED: if the record cannot be written, the write is refused. */
  private authority(type: Parameters<ReturnType<MoneyLayerAuditLog['authority']>['append']>[0], actor: string, detail: Record<string, unknown>): void {
    this.d.audit.authority().append(type, actor, detail);
  }

  private readStoreSafe(): ReturnType<MoneyLayerEnableStore['read']> | null {
    try {
      return this.d.store.read();
    } catch (err) {
      // @silent-fallback-ok: NOT silent — it logs that the status is being
      // reported without stored state, which is the honest degradation rather
      // than a confident answer built on an unreadable file.
      // NULL degrades the status read to "no stored failure, no transition
      // time" — survivable, but never silently: an unreadable money store is
      // the condition under which this surface's answers are least trustworthy,
      // so it says so rather than presenting a confident-looking status built
      // on a file it could not read.
      console.error(`[money-layer] status read could not load the enable store — reporting without stored failure/transition state: ${String(err)}`);
      return null;
    }
  }

  private recordFailureSafe(state: 'probe-failed' | 'construction-failed', component: string): void {
    try {
      this.d.store.recordFailure(state, component);
    } catch (err) {
      // @silent-fallback-ok: NOT silent — it logs. Proceeding is deliberate: the
      // probe verdict for THIS process is already recorded in memory, so the
      // surface still reports the failure honestly right now; only its survival
      // across a restart is lost, and refusing the probe over that would be a
      // worse outcome than a degraded-but-reported one.
      console.error(`[money-layer] could not persist the failure record: ${String(err)}`);
    }
  }

  private clearFailureSafe(): void {
    try {
      this.d.store.clearFailure();
    } catch (err) {
      console.error(`[money-layer] could not clear the failure record: ${String(err)}`);
    }
  }

  private safeSettlingCount(): number {
    try {
      const n = this.d.settlingCount();
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  private enforcePlanRenderRate(): void {
    const cutoff = this.now() - 60 * 60 * 1000;
    this.planRenderTimes = this.planRenderTimes.filter((t) => t > cutoff);
    if (this.planRenderTimes.length >= this.limits.planRenderPerHour) {
      throw new MoneyLayerRefusal(429, 'plan-render-rate', `plan rendering is limited to ${this.limits.planRenderPerHour} per hour on this machine`);
    }
    this.planRenderTimes.push(this.now());
  }

  /**
   * The ONE place a PIN answer is turned into a decision.
   *
   * SECOND-PASS FINDING 1 — `config-inspect` compared the PIN inline and
   * returned observably different fields on success, without touching the
   * lockout counter: an unlimited six-digit oracle for a Bearer holder, whose
   * prize was the credential that commits money and restarts the server. Every
   * PIN-taking route now calls THIS, so a route cannot accidentally opt out of
   * the lockout by comparing the PIN itself.
   *
   * Returns the verdict; the caller decides what a false means for its route
   * (401 for an authority action, "limits withheld" for the inspect read).
   */
  checkPin(valid: boolean, route: string): boolean {
    this.enforceNotLockedOut();
    if (!valid) this.recordPinFailure(route);
    return valid;
  }

  private enforceNotLockedOut(): void {
    if (this.now() < this.lockoutUntil) {
      throw new MoneyLayerRefusal(429, 'pin-lockout', `too many failed PIN attempts — locked out for another ${Math.ceil((this.lockoutUntil - this.now()) / 1000)}s`);
    }
  }

  private recordPinFailure(route: string): void {
    const cutoff = this.now() - this.limits.pinLockoutSeconds * 1000;
    this.pinFailures = this.pinFailures.filter((t) => t > cutoff);
    this.pinFailures.push(this.now());
    this.auditOnly('pin-attempt-failed', 'unknown', { route });
    if (this.pinFailures.length >= this.limits.pinFailuresBeforeLockout) {
      this.lockoutUntil = this.now() + this.limits.pinLockoutSeconds * 1000;
      this.pinFailures = [];
    }
  }
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return ha.length === hb.length && crypto.timingSafeEqual(ha, hb);
}
