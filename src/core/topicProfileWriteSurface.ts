/**
 * TopicProfileWriteSurface — the ONE platform-agnostic write engine behind all
 * Topic Profile write surfaces (TOPIC-PROFILE-SPEC §5.2, §10.1–§10.4):
 * conversational ingress, the /topic command, the rewired /route command, the
 * token-trust HTTP route, the §10.1 propose-confirm lane, and the §5.2(b)
 * recovery writes (undo / clear / re-apply).
 *
 * Regime law implemented here (the spec's hardest-won invariants):
 *
 *  - §5.2(d): FRAMEWORK-arm writes via the pre-existing `/route` surface (and
 *    equivalent conversational switches) are EXEMPT from BOTH gating knobs —
 *    always a LIVE store write, never routed to the §14 dry-run shadow — and
 *    wherever the new §8 orchestration is not fully live (`enabled:false` OR
 *    `dryRun:true`), the switch is served end-to-end by the LEGACY path,
 *    byte-for-byte today's shipped behavior (immediate kill + CONTINUATION
 *    respawn with the resume-UUID drop).
 *  - The NEW axes (model / modelTier / thinkingMode / escalationOverride) are
 *    gated: refused while disabled; shadowed (`intendedProfile`) under
 *    dryRun; live only when `enabled && !dryRun`.
 *  - §5.2(b): the recovery writes — re-apply and CLEAR — are LIVE writes in
 *    EVERY regime (never refused as new pins, never shadowed), but their
 *    APPLICATION arm is regime-governed: outside the fully-live regime there
 *    is NO profile-triggered kill — the write applies at the next natural
 *    spawn / boot-sweep reconcile, and the confirmation says so out loud.
 *  - §10.1: `updatedBy` is stamped server-side from the VERIFIED principal —
 *    operator-attributed only on the platform-authenticated surfaces; HTTP is
 *    token-trust (`updatedBy:'api-token'`), never operator-attributed, and a
 *    body-supplied updatedBy is ignored by construction (it never reaches
 *    this module). Writes refuse when the sender is not the topic's bound
 *    operator (or, for token writes, when NO bound operator exists).
 *  - §8: EVERY accepted write discloses — one line, delta-carrying, carrying
 *    the audit sequence stamp so the relay's exact-duplicate window can never
 *    silently swallow a repeat notice. The undo snapshot (`previous`) shifts
 *    once per disclosed write (no §8 coalescing window exists until the
 *    orchestrator serves the fully-live regime, so every accepted write here
 *    is individually disclosed — the spec's outside-a-window cadence).
 *
 * §8 ORCHESTRATION SEAM (TODO-wire): `deps.orchestrator` is the call site for
 * TopicProfileOrchestrator (built in parallel). When present AND the regime
 * is fully-live, profile-triggered respawns hand off to it (debounce, idle
 * re-confirm, classification, parking). Until it is wired:
 *  - framework switches are served by the legacy respawn in every regime
 *    (today's shipped behavior — the §5.2(d) contract, audited
 *    `orchestration-unavailable` when it happens in the fully-live regime);
 *  - new-axis live writes apply at the next natural spawn, told out loud.
 */

import type { TopicProfileStore, TopicProfile } from './TopicProfileStore.js';
import { ProfileValidationRefusal, ProfileLockTimeoutError, FlushRefusedError } from './TopicProfileStore.js';
import type { TopicProfileResolver } from './TopicProfileResolver.js';
import {
  validateProfileFields,
  type ProfilePatchInput,
  type ProfileValidationError,
  type ValidatedProfilePatch,
} from './topicProfileValidation.js';
import type { IntelligenceFramework } from './intelligenceProviderFactory.js';

// ── locally-defined shared types (noted in the build report) ────────────────

/** The two gating knobs, resolved live (§5.2/§14). */
export interface ProfileWriteRegime {
  enabled: boolean;
  dryRun: boolean;
}

/** The VERIFIED principal a write runs as (§10.1 — stamped server-side). */
export type ProfileWritePrincipal =
  | { kind: 'operator'; platform: string; uid: string }
  | { kind: 'token' };

export type ProfileWriteOrigin =
  | 'conversational'
  | 'slash-topic'
  | 'slash-route'
  | 'http'
  | 'propose-confirm';

/**
 * §8 interface seam for TopicProfileOrchestrator (built in parallel — see the
 * module doc). Structural-only: the write surface calls this AFTER the live
 * store write; the orchestrator owns the debounced, idle-gated respawn.
 */
export interface ProfileOrchestratorLike {
  onProfileWrite(
    topicKey: string,
    info: { frameworkChanged: boolean; origin: ProfileWriteOrigin },
  ): void | Promise<void>;
}

export interface ProfileWriteResult {
  ok: boolean;
  /** Operator-facing reply text (refusal or confirmation+disclosure). */
  reply: string;
  /** Structured refusal when ok:false. */
  refusal?: { reason: string; validation?: ProfileValidationError };
  /** True when the accepted write changed nothing (no-op). */
  noop?: boolean;
  /** Fields that landed LIVE in the store. */
  appliedLive?: string[];
  /** Fields recorded to the §14 dry-run shadow. */
  shadowed?: string[];
  /** Fields refused by the disabled gate (mixed-delta split, §10.1). */
  refusedFields?: string[];
  /** A §10.4 parked pin was superseded by this write (named in the reply). */
  supersededParked?: boolean;
  /** The legacy immediate respawn fired (§5.2(d)). */
  legacyRespawned?: boolean;
}

export interface ReapplyResult extends ProfileWriteResult {
  /** §10.4 cooldown: the re-apply needs an explicit confirm first. */
  needsConfirm?: boolean;
}

export interface TopicProfileWriteSurfaceDeps {
  store: TopicProfileStore;
  resolver: TopicProfileResolver;
  /** Live gating knobs (enabled via resolveDevAgentGate; dryRun from config). */
  regime: () => ProfileWriteRegime;
  /** The topic's bound operator (§10.1) — null when none bound. */
  boundOperator: (topicKey: string) => { platform: string; uid: string } | null;
  /** Active `/local-model` binding (§5.2 — refuses cloud model pins). */
  localModelBinding: (topicKey: string) => { provider: string } | null;
  /**
   * §5.2(d) legacy respawn — today's exact `/route` behavior: drop the resume
   * UUID, kill, CONTINUATION respawn. Only invoked for framework-arm changes.
   * Returns respawned:false when the topic has no live session (write still
   * lands; takes effect at next spawn).
   */
  legacyFrameworkRespawn: (topicKey: string) => Promise<{ respawned: boolean; error?: string }>;
  /** §8 orchestrator seam (TODO-wire — null until the parallel build lands). */
  orchestrator?: ProfileOrchestratorLike | null;
  /**
   * §5.3 transfer-carrier cancel marker (TopicProfileTransferCarrier.
   * onLocalWriteDurable). Called immediately after a successful `await
   * store.mutate(...)` — mutate resolves only after its flush durably landed,
   * so a FlushRefusedError throw cancels nothing (the §5.3 round-8 rule).
   * Operator and token-trust HTTP writes cancel a pending transfer pull;
   * system writes never reach this surface.
   */
  onLocalWriteDurable?: (topicKey: string, origin: 'operator' | 'http') => void;
  /**
   * Post the §8 disclosure line to the topic's owning platform conversation.
   * Callers whose command REPLY is the disclosure-of-record (slash surfaces)
   * suppress this via discloseInReply instead.
   */
  disclose: (topicKey: string, text: string) => Promise<void>;
  /**
   * §10.3 audit sink. Returns the audit sequence stamp included in rendered
   * disclosures (or void — a timestamp is used instead).
   */
  audit: (event: Record<string, unknown>) => string | void;
  /** §10.4 re-apply cooldown (hardcoded v1 constant unless injected). */
  reapplyCooldownMs?: number;
  now?: () => number;
}

const NEW_AXES = ['model', 'modelTier', 'thinkingMode', 'effort', 'escalationOverride'] as const;
const ALL_FIELDS = ['framework', ...NEW_AXES] as const;
const DEFAULT_REAPPLY_COOLDOWN_MS = 600_000;

export class TopicProfileWriteSurface {
  private readonly deps: TopicProfileWriteSurfaceDeps;
  private readonly now: () => number;

  constructor(deps: TopicProfileWriteSurfaceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  // ── the main write path ───────────────────────────────────────────────────

  async applyWrite(req: {
    topicKey: string | number;
    patch: ProfilePatchInput;
    principal: ProfileWritePrincipal;
    origin: ProfileWriteOrigin;
    /** The caller's reply carries the disclosure-of-record (slash surfaces). */
    discloseInReply?: boolean;
    /** §10.1 propose-confirm provenance flag for the audit. */
    agentComposedPayload?: boolean;
  }): Promise<ProfileWriteResult> {
    const topicKey = String(req.topicKey);
    const regime = this.deps.regime();

    // ── §10.1 principal / bound-operator gate ──────────────────────────────
    const authRefusal = this.authorize(topicKey, req.principal, req.origin);
    if (authRefusal) return authRefusal;
    const updatedBy = this.principalStamp(req.principal);

    // ── §10.2 closed-enum clamp (every field, before persist) ──────────────
    const resolved = this.deps.resolver.resolve(topicKey);
    const validated = validateProfileFields(req.patch, resolved.framework);
    if (!validated.ok) {
      this.deps.audit({
        type: 'write',
        outcome: 'refused',
        reason: `validation:${validated.error.failure}`,
        field: validated.error.field,
        rejectedPrefix: validated.error.rejectedPrefix,
        rejectedLength: validated.error.rejectedLength,
        topic: topicKey,
        principal: updatedBy,
        origin: req.origin,
      });
      return {
        ok: false,
        reply: `Can't apply that: ${validated.error.reason}. The profile is unchanged.`,
        refusal: { reason: 'validation', validation: validated.error },
      };
    }
    const patch = validated.patch;

    // ── §5.2 local-model-binding precedence (cloud pin refused) ────────────
    if ((patch.model != null || patch.modelTier != null) && this.deps.localModelBinding(topicKey)) {
      this.deps.audit({
        type: 'write', outcome: 'refused', reason: 'local-model-binding-active',
        topic: topicKey, principal: updatedBy, origin: req.origin,
      });
      return {
        ok: false,
        reply: `This topic has a local-model binding — clear it first (say "/local-model off") to pin a cloud model.`,
        refusal: { reason: 'local-model-binding-active' },
      };
    }

    // ── mixed-delta split (§5.2(d) + §10.1 round-12) ───────────────────────
    const frameworkArm: ValidatedProfilePatch = {};
    if (patch.framework !== undefined) frameworkArm.framework = patch.framework;

    const liveNewAxes: ValidatedProfilePatch = {};
    const shadowNewAxes: ValidatedProfilePatch = {};
    const refusedFields: string[] = [];
    for (const field of NEW_AXES) {
      const value = patch[field];
      if (value === undefined) continue;
      if (value === null) {
        // §5.2(b): clearing a pin is a recovery write — permitted (LIVE) in
        // every regime, never shadowed.
        (liveNewAxes as Record<string, unknown>)[field] = null;
      } else if (!regime.enabled) {
        refusedFields.push(field);
      } else if (regime.dryRun) {
        (shadowNewAxes as Record<string, unknown>)[field] = value;
      } else {
        (liveNewAxes as Record<string, unknown>)[field] = value;
      }
    }

    const frameworkChanged =
      frameworkArm.framework !== undefined
      && (this.deps.store.resolve(topicKey)?.framework ?? null) !== frameworkArm.framework;

    // ── live store write (framework arm — always — plus live new axes) ─────
    const livePatch: ValidatedProfilePatch = { ...frameworkArm, ...liveNewAxes };
    const liveFields = Object.keys(livePatch);
    const shadowFields = Object.keys(shadowNewAxes);

    if (liveFields.length === 0 && shadowFields.length === 0) {
      if (refusedFields.length > 0) {
        // §5.2 disabled-flag semantics: NEW operator pins are refused while
        // the feature is off (reads still honor existing pins).
        this.deps.audit({
          type: 'write', outcome: 'refused', reason: 'disabled',
          fields: refusedFields, topic: topicKey, principal: updatedBy, origin: req.origin,
        });
        return {
          ok: false,
          reply: `The ${refusedFields.join('/')} control isn't enabled on this agent — the profile is unchanged.`,
          refusal: { reason: 'disabled' },
          refusedFields,
        };
      }
      return { ok: false, reply: 'Nothing to change — say what you want set on this topic.', refusal: { reason: 'empty-patch' } };
    }

    const before = this.profileSnapshot(topicKey);
    let supersededParked = false;
    let changed = false;
    if (liveFields.length > 0) {
      try {
        const result = await this.deps.store.mutate(
          topicKey,
          { ...livePatch, updatedBy },
          // §5.1 cadence: every accepted write here is individually disclosed
          // (no §8 coalescing window until the orchestrator is live).
          { shiftPrevious: true },
        );
        changed = result.changed;
        supersededParked = result.supersededParked;
      } catch (err) {
        return this.writeFailure(err, topicKey, updatedBy, req.origin);
      }
      // §5.3: the mutate's flush durably landed (mutate resolved) — a local
      // operator/HTTP write cancels any pending transfer-pull REPLACE.
      this.notifyLocalWriteDurable(topicKey, req.origin);
    }

    if (shadowFields.length > 0) {
      try {
        // §14: the dry-run shadow records the intent; resolution never reads it.
        const current = this.deps.store.get(topicKey)?.intendedProfile?.fields ?? {};
        await this.deps.store.setShadow(topicKey, { ...current, ...shadowNewAxes }, updatedBy);
      } catch (err) {
        return this.writeFailure(err, topicKey, updatedBy, req.origin);
      }
    }

    const after = this.profileSnapshot(topicKey);
    const seq = this.deps.audit({
      type: 'write',
      outcome: 'accepted',
      topic: topicKey,
      principal: updatedBy,
      origin: req.origin,
      ...(req.agentComposedPayload ? { payloadProvenance: 'agent-composed' } : {}),
      appliedLive: liveFields,
      shadowed: shadowFields,
      refusedFields,
      old: before,
      new: after,
      ...(supersededParked ? { supersededParked: true } : {}),
    }) ?? new Date(this.now()).toISOString();

    // ── application arm ─────────────────────────────────────────────────────
    const fullyLive = regime.enabled && !regime.dryRun;
    let legacyRespawned = false;
    let respawnNote = '';
    if (frameworkChanged && changed) {
      if (fullyLive && this.deps.orchestrator) {
        // §8 fully-live orchestration (debounce, busy-refusal, parking).
        await this.deps.orchestrator.onProfileWrite(topicKey, { frameworkChanged: true, origin: req.origin });
        respawnNote = ' Applying shortly (waiting for an idle moment).';
      } else {
        // §5.2(d): the legacy path serves the switch byte-for-byte — immediate
        // kill + CONTINUATION respawn, resume-UUID drop. In the fully-live
        // regime with no orchestrator wired this is the keep-working fallback.
        if (fullyLive) this.deps.audit({ type: 'orchestration-unavailable', topic: topicKey });
        const respawn = await this.deps.legacyFrameworkRespawn(topicKey);
        legacyRespawned = respawn.respawned;
        respawnNote = respawn.respawned
          ? ' Session respawned — recent history carries over; the full transcript can\'t follow across frameworks.'
          : respawn.error
            ? ` Persisted, but the respawn failed: ${respawn.error} — it takes effect on this topic's next session.`
            : ' Takes effect when a session starts for this topic.';
      }
    } else if (Object.keys(liveNewAxes).length > 0 && changed) {
      if (fullyLive && this.deps.orchestrator) {
        await this.deps.orchestrator.onProfileWrite(topicKey, { frameworkChanged: false, origin: req.origin });
        respawnNote = ' Applying shortly (waiting for an idle moment).';
      } else {
        // No profile-triggered kill outside the fully-live orchestration —
        // told out loud (§5.2(b) precedent: apply-at-next-spawn, boot-sweep
        // reconcile is the backstop).
        respawnNote = ' Takes effect at this topic\'s next session restart.';
      }
    }

    // ── §8 disclosure (delta-carrying, audit-stamped) ───────────────────────
    const parts: string[] = [];
    if (liveFields.length > 0) {
      parts.push(`${this.renderDelta(before, after)}${respawnNote}`);
    }
    if (shadowFields.length > 0) {
      parts.push(
        `[dry-run] recorded as an intent, not applied: ${shadowFields.map(f => `${f} → ${String((shadowNewAxes as Record<string, unknown>)[f])}`).join(', ')} — the new profile machinery is in its observation canary on this agent.`,
      );
    }
    if (refusedFields.length > 0) {
      parts.push(`Not applied (the ${refusedFields.join('/')} control isn't enabled on this agent): re-issue once it's on.`);
    }
    if (supersededParked) {
      parts.push('Your previously parked pin was superseded by this change.');
    }
    if (liveFields.length > 0 && !changed && shadowFields.length === 0 && refusedFields.length === 0) {
      return { ok: true, noop: true, reply: 'Already set — nothing to change.', appliedLive: [] };
    }

    const reply = `${parts.join('\n')}\n(profile change ${seq}${req.origin === 'http' ? ', via API' : ''})`;
    if (!req.discloseInReply && (liveFields.length > 0 || shadowFields.length > 0)) {
      // §8: token-trust/HTTP writes (and any caller whose reply isn't the
      // topic conversation) post the disclosure to the topic itself.
      await this.deps.disclose(topicKey, reply).catch(() => { /* best-effort */ });
    }

    return {
      ok: true,
      reply,
      appliedLive: liveFields,
      shadowed: shadowFields,
      refusedFields,
      supersededParked,
      legacyRespawned,
      noop: liveFields.length > 0 ? !changed : undefined,
    };
  }

  // ── §10.3 undo ────────────────────────────────────────────────────────────

  async undo(req: {
    topicKey: string | number;
    principal: ProfileWritePrincipal;
    origin: ProfileWriteOrigin;
    discloseInReply?: boolean;
  }): Promise<ProfileWriteResult> {
    const topicKey = String(req.topicKey);
    const authRefusal = this.authorize(topicKey, req.principal, req.origin);
    if (authRefusal) return authRefusal;
    const updatedBy = this.principalStamp(req.principal);

    const previous = this.deps.store.previousFor(topicKey);
    const current = this.deps.store.resolve(topicKey);
    if (current === null) {
      return { ok: false, reply: 'Nothing to undo yet — this topic has no recorded profile change.', refusal: { reason: 'nothing-to-undo' } };
    }
    if (previous === null && current.updatedBy.startsWith('system:')) {
      // §5.1: a legacy-seeded entry initializes previous:null — there is no
      // operator-disclosed change to restore; refused plainly.
      return { ok: false, reply: 'Nothing to undo yet — there\'s no earlier profile snapshot for this topic.', refusal: { reason: 'nothing-to-undo' } };
    }
    // previous === null after a FIRST disclosed pin is a GENUINE snapshot
    // ("no profile" — the pre-pin defaults): the shift recorded current=null
    // at write time, so undo of a first (possibly hostile) pin clears it.

    // Full-field restore (undo is a REPLACE-shaped write: absent fields clear).
    const patch: ValidatedProfilePatch = {};
    for (const field of ALL_FIELDS) {
      (patch as Record<string, unknown>)[field] = previous
        ? ((previous as unknown as Record<string, unknown>)[field] ?? null)
        : null;
    }
    const frameworkChanged = (current.framework ?? null) !== (previous?.framework ?? null);

    const before = this.profileSnapshot(topicKey);
    let changed = false;
    try {
      const result = await this.deps.store.mutate(topicKey, { ...patch, updatedBy }, { shiftPrevious: true });
      changed = result.changed;
    } catch (err) {
      return this.writeFailure(err, topicKey, updatedBy, req.origin);
    }
    // §5.3 cancel marker — the undo's mutate flushed durably.
    this.notifyLocalWriteDurable(topicKey, req.origin);
    if (!changed) {
      return { ok: true, noop: true, reply: 'You\'re already back where you started — nothing to undo.' };
    }
    const after = this.profileSnapshot(topicKey);
    const seq = this.deps.audit({
      type: 'undo', outcome: 'accepted', topic: topicKey, principal: updatedBy,
      origin: req.origin, old: before, new: after,
    }) ?? new Date(this.now()).toISOString();

    const regime = this.deps.regime();
    const fullyLive = regime.enabled && !regime.dryRun;
    let note = '';
    if (frameworkChanged) {
      if (fullyLive && this.deps.orchestrator) {
        await this.deps.orchestrator.onProfileWrite(topicKey, { frameworkChanged: true, origin: req.origin });
        note = ' Applying shortly.';
      } else {
        // §8 round-12: a legacy-served switch dropped the resume UUID, so the
        // undo recovers via CONTINUATION — recent-context loss, NAMED in the
        // reply (nothing parked to un-park on the legacy path).
        const respawn = await this.deps.legacyFrameworkRespawn(topicKey);
        note = respawn.respawned
          ? ' Fresh thread — the old conversation can\'t be resumed across that switch, so I\'m carrying recent history only.'
          : ' Takes effect when a session starts for this topic.';
      }
    } else if (fullyLive && this.deps.orchestrator) {
      await this.deps.orchestrator.onProfileWrite(topicKey, { frameworkChanged: false, origin: req.origin });
      note = ' Applying shortly.';
    } else {
      note = ' Takes effect at this topic\'s next session restart.';
    }

    const reply = `Undone — ${this.renderDelta(before, after)}.${note}\n(profile change ${seq})`;
    if (!req.discloseInReply) await this.deps.disclose(topicKey, reply).catch(() => {});
    return { ok: true, reply, appliedLive: Object.keys(patch) };
  }

  // ── §5.2(b) recovery writes: clear + re-apply ────────────────────────────

  /** CLEAR — a recovery write: LIVE in every regime, never shadowed. */
  async clear(req: {
    topicKey: string | number;
    principal: ProfileWritePrincipal;
    origin: ProfileWriteOrigin;
    discloseInReply?: boolean;
  }): Promise<ProfileWriteResult> {
    const topicKey = String(req.topicKey);
    const authRefusal = this.authorize(topicKey, req.principal, req.origin);
    if (authRefusal) return authRefusal;
    const updatedBy = this.principalStamp(req.principal);

    const before = this.profileSnapshot(topicKey);
    const hadFramework = this.deps.store.resolve(topicKey)?.framework != null;
    let changed = false;
    try {
      const result = await this.deps.store.mutate(
        topicKey,
        { framework: null, model: null, modelTier: null, thinkingMode: null, effort: null, escalationOverride: null, updatedBy },
        { shiftPrevious: true },
      );
      changed = result.changed;
    } catch (err) {
      return this.writeFailure(err, topicKey, updatedBy, req.origin);
    }
    // §5.3 cancel marker — the clear's mutate flushed durably.
    this.notifyLocalWriteDurable(topicKey, req.origin);
    if (!changed) {
      return { ok: true, noop: true, reply: 'This topic has no profile pins — nothing to clear.' };
    }
    const seq = this.deps.audit({
      type: 'clear', outcome: 'accepted', topic: topicKey, principal: updatedBy,
      origin: req.origin, old: before,
    }) ?? new Date(this.now()).toISOString();

    // §5.2(b): the APPLICATION arm is regime-governed — no profile-triggered
    // kill outside the fully-live orchestration; told out loud.
    const regime = this.deps.regime();
    const fullyLive = regime.enabled && !regime.dryRun;
    let note: string;
    if (fullyLive && this.deps.orchestrator) {
      await this.deps.orchestrator.onProfileWrite(topicKey, { frameworkChanged: hadFramework, origin: req.origin });
      note = 'Applying shortly.';
    } else {
      note = 'Cleared — takes effect at this topic\'s next session restart.';
    }

    const reply = `${note} This topic is back on the defaults.\n(profile change ${seq})`;
    if (!req.discloseInReply) await this.deps.disclose(topicKey, reply).catch(() => {});
    return { ok: true, reply, appliedLive: [...ALL_FIELDS] };
  }

  /**
   * RE-APPLY the §10.4 parked (intended-but-unhealthy) pin — a recovery
   * write: LIVE in every regime. Carries the §10.4 cooldown guard: re-applying
   * the same profile that just tripped the breaker requires an explicit
   * confirm (the caller arms the shared confirm slot with the returned echo).
   */
  async reapply(req: {
    topicKey: string | number;
    principal: ProfileWritePrincipal;
    origin: ProfileWriteOrigin;
    /** The operator already confirmed through the §10.4 cooldown echo. */
    confirmed?: boolean;
    discloseInReply?: boolean;
  }): Promise<ReapplyResult> {
    const topicKey = String(req.topicKey);
    const authRefusal = this.authorize(topicKey, req.principal, req.origin);
    if (authRefusal) return authRefusal;
    const updatedBy = this.principalStamp(req.principal);

    const parked = this.deps.store.parkedFor(topicKey);
    if (!parked) {
      // §10.4 supersession wording: after a new deliberate pin, re-apply has
      // nothing parked.
      const hasProfile = this.deps.store.resolve(topicKey) !== null;
      return {
        ok: false,
        reply: hasProfile
          ? 'Nothing parked — you\'ve since set a new profile for this topic.'
          : 'Nothing parked on this topic.',
        refusal: { reason: 'nothing-parked' },
      };
    }

    const cooldownMs = this.deps.reapplyCooldownMs ?? DEFAULT_REAPPLY_COOLDOWN_MS;
    const parkedAgeMs = this.now() - Date.parse(parked.parkedAt);
    if (!req.confirmed && Number.isFinite(parkedAgeMs) && parkedAgeMs < cooldownMs) {
      const echo = `This exact profile failed to launch ${Math.max(1, Math.round(parkedAgeMs / 60_000))} minute(s) ago (${parked.reason}) — apply it anyway?`;
      this.deps.audit({ type: 'reapply', outcome: 'needs-confirm', topic: topicKey, principal: updatedBy, origin: req.origin });
      return { ok: false, needsConfirm: true, reply: echo, refusal: { reason: 'cooldown-confirm-required' } };
    }

    const patch: ValidatedProfilePatch = {};
    for (const field of ALL_FIELDS) {
      (patch as Record<string, unknown>)[field] = (parked.profile as unknown as Record<string, unknown>)[field] ?? null;
    }
    const frameworkChanged = (this.deps.store.resolve(topicKey)?.framework ?? null) !== (parked.profile.framework ?? null);

    const before = this.profileSnapshot(topicKey);
    try {
      // The operator-attributed mutate atomically clears the parked state +
      // breaker counter (store supersession discipline).
      await this.deps.store.mutate(topicKey, { ...patch, updatedBy }, { shiftPrevious: true });
    } catch (err) {
      return this.writeFailure(err, topicKey, updatedBy, req.origin);
    }
    // §5.3 cancel marker — the re-apply's mutate flushed durably.
    this.notifyLocalWriteDurable(topicKey, req.origin);
    const after = this.profileSnapshot(topicKey);
    const seq = this.deps.audit({
      type: 'reapply', outcome: 'accepted', topic: topicKey, principal: updatedBy,
      origin: req.origin, ...(req.confirmed ? { cooldownOverridden: true } : {}),
      old: before, new: after,
    }) ?? new Date(this.now()).toISOString();

    const regime = this.deps.regime();
    const fullyLive = regime.enabled && !regime.dryRun;
    let note: string;
    if (fullyLive && this.deps.orchestrator) {
      await this.deps.orchestrator.onProfileWrite(topicKey, { frameworkChanged, origin: req.origin });
      note = 'Re-applied — applying shortly.';
    } else {
      // §5.2(b): recovery writes never profile-kill outside fully-live.
      note = 'Re-applied — takes effect at this topic\'s next session restart.';
    }

    const reply = `${note} (${this.renderDelta(before, after)})\n(profile change ${seq})`;
    if (!req.discloseInReply) await this.deps.disclose(topicKey, reply).catch(() => {});
    return { ok: true, reply, appliedLive: Object.keys(patch) };
  }

  // ── §10.1 propose lane (server-rendered echo) ───────────────────────────

  /**
   * Validate + render the SERVER-side echo for an agent-composed proposal.
   * The echo names each arm's fate under the live regime BEFORE the confirm
   * (mixed-delta split, round-12) — what the operator confirms is mechanically
   * what will be written. The caller arms the shared confirm slot with the
   * returned patch+echo and sends the echo to the topic.
   */
  renderProposalEcho(
    topicKey: string | number,
    patch: ProfilePatchInput,
  ): { ok: true; echo: string; patch: ValidatedProfilePatch } | { ok: false; reply: string; validation?: ProfileValidationError } {
    const key = String(topicKey);
    const resolved = this.deps.resolver.resolve(key);
    const validated = validateProfileFields(patch, resolved.framework);
    if (!validated.ok) {
      return { ok: false, reply: `Can't propose that: ${validated.error.reason}.`, validation: validated.error };
    }
    if ((validated.patch.model != null || validated.patch.modelTier != null) && this.deps.localModelBinding(key)) {
      return { ok: false, reply: 'This topic has a local-model binding — clear it first to pin a cloud model.' };
    }
    const regime = this.deps.regime();
    const lines: string[] = ['Proposed profile change for this topic:'];
    for (const field of ALL_FIELDS) {
      const value = (validated.patch as Record<string, unknown>)[field];
      if (value === undefined) continue;
      const rendered = value === null ? 'cleared' : String(value);
      if (field === 'framework') {
        lines.push(`  • framework → ${rendered}: switches now (live)`);
      } else if (value === null) {
        lines.push(`  • ${field} → ${rendered}: applies now (recovery write, live in every regime)`);
      } else if (!regime.enabled) {
        lines.push(`  • ${field} → ${rendered}: refused — the ${field} control isn't enabled on this agent`);
      } else if (regime.dryRun) {
        lines.push(`  • ${field} → ${rendered}: recorded as a dry-run intent (not applied)`);
      } else {
        lines.push(`  • ${field} → ${rendered}: applies after you confirm`);
      }
    }
    if (lines.length === 1) return { ok: false, reply: 'Nothing to propose — the delta is empty.' };
    lines.push('Reply "yes" to apply exactly the above.');
    return { ok: true, echo: lines.join('\n'), patch: validated.patch };
  }

  // ── readout (conversational + /topic status) ─────────────────────────────

  renderReadout(topicKey: string | number): string {
    const key = String(topicKey);
    const entry = this.deps.store.get(key);
    const resolved = this.deps.resolver.resolve(key);
    const lines: string[] = [];
    lines.push(
      `This topic runs on ${resolved.framework}`
      + (resolved.model ? ` with model ${resolved.model}` : ' with the account-default model')
      + (resolved.thinkingMode ? ` and ${resolved.thinkingMode} thinking` : '')
      + (resolved.effort ? ` at ${resolved.effort} effort` : '')
      + ` (framework: ${resolved.sources.framework}, model: ${resolved.sources.model}).`,
    );
    // §9 framework-aware escalation disclosure.
    if (resolved.escalationOverride === 'suppress') {
      lines.push('Auto-escalation is OFF for this topic — heavy work stays on the pinned baseline.');
    } else if (resolved.framework === 'claude-code') {
      lines.push('Heavy work (specs/builds) still auto-escalates to the ultra model here.');
    } else {
      lines.push(`Heads up: heavy work in this topic won't auto-escalate while it's on ${resolved.framework} (no escalated model configured for it).`);
    }
    if (entry?.parked) {
      lines.push(`A pin is parked as unhealthy (${entry.parked.reason}) — say "re-apply" to restore it.`);
    }
    if (entry?.intendedProfile) {
      const fields = Object.entries(entry.intendedProfile.fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', ');
      lines.push(`Would-be (dry-run intent, not applied): ${fields}.`);
    }
    return lines.join('\n');
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private authorize(
    topicKey: string,
    principal: ProfileWritePrincipal,
    origin: ProfileWriteOrigin,
  ): ProfileWriteResult | null {
    const bound = this.deps.boundOperator(topicKey);
    if (principal.kind === 'token') {
      // §10.1: token-trust still refuses writes to topics with no bound operator.
      if (!bound) {
        this.deps.audit({ type: 'write', outcome: 'refused', reason: 'no-bound-operator', topic: topicKey, principal: 'api-token', origin });
        return {
          ok: false,
          reply: 'This topic has no bound operator yet — it gets one the first time its operator messages the topic.',
          refusal: { reason: 'no-bound-operator' },
        };
      }
      return null;
    }
    if (!bound) {
      this.deps.audit({ type: 'write', outcome: 'refused', reason: 'no-bound-operator', topic: topicKey, principal: `${principal.platform}:${principal.uid}`, origin });
      return {
        ok: false,
        reply: 'I couldn\'t determine this topic\'s operator, so I\'m not changing its profile.',
        refusal: { reason: 'no-bound-operator' },
      };
    }
    if (bound.platform !== principal.platform || bound.uid !== principal.uid) {
      this.deps.audit({
        type: 'write', outcome: 'refused', reason: 'not-bound-operator', topic: topicKey,
        assertedPrincipal: `${principal.platform}:${principal.uid}`, origin,
      });
      return {
        ok: false,
        reply: 'Only this topic\'s operator can change its profile.',
        refusal: { reason: 'not-bound-operator' },
      };
    }
    return null;
  }

  private principalStamp(principal: ProfileWritePrincipal): string {
    return principal.kind === 'token' ? 'api-token' : `${principal.platform}:${principal.uid}`;
  }

  /**
   * §5.3 — notify the transfer carrier a local write durably landed (cancels
   * any pending transfer-pull REPLACE for the topic). Only ever called AFTER
   * `await store.mutate(...)` resolved; a flush-refused mutate throws first
   * and cancels nothing (the round-8 rule by construction).
   */
  private notifyLocalWriteDurable(topicKey: string, origin: ProfileWriteOrigin): void {
    try {
      this.deps.onLocalWriteDurable?.(topicKey, origin === 'http' ? 'http' : 'operator');
    } catch {
      /* @silent-fallback-ok: the §5.3 cancel marker is a post-write amendment to the carrier's pending-pull ledger — a carrier failure must never refuse or roll back a write that already durably landed; the updatedAt backstop still protects the topic at pull-landing time (TOPIC-PROFILE-SPEC §5.3) */
    }
  }

  private profileSnapshot(topicKey: string): Record<string, unknown> {
    const current = this.deps.store.resolve(topicKey);
    const out: Record<string, unknown> = {};
    if (!current) return out;
    for (const field of ALL_FIELDS) {
      const v = (current as unknown as Record<string, unknown>)[field];
      if (v != null) out[field] = v;
    }
    return out;
  }

  private renderDelta(before: Record<string, unknown>, after: Record<string, unknown>): string {
    const renderSide = (side: Record<string, unknown>): string => {
      const entries = Object.entries(side);
      if (entries.length === 0) return 'defaults';
      return entries.map(([k, v]) => `${k}: ${String(v)}`).join(', ');
    };
    return `Topic profile — was: ${renderSide(before)} → now: ${renderSide(after)}`;
  }

  private writeFailure(
    err: unknown,
    topicKey: string,
    principal: string,
    origin: ProfileWriteOrigin,
  ): ProfileWriteResult {
    if (err instanceof ProfileValidationRefusal) {
      this.deps.audit({
        type: 'write', outcome: 'refused', reason: `validation:${err.validation.failure}`,
        field: err.validation.field, topic: topicKey, principal, origin,
      });
      return { ok: false, reply: `Can't apply that: ${err.validation.reason}. The profile is unchanged.`, refusal: { reason: 'validation', validation: err.validation } };
    }
    if (err instanceof FlushRefusedError) {
      // §5.1: a failed flush REFUSES out loud + already rolled the cache back.
      this.deps.audit({ type: 'write', outcome: 'refused', reason: 'flush-failed', topic: topicKey, principal, origin });
      return { ok: false, reply: 'Couldn\'t save that change durably — nothing was applied. Try again in a moment.', refusal: { reason: 'flush-failed' } };
    }
    if (err instanceof ProfileLockTimeoutError) {
      // §8: WRITE-phase lock timeout is a spoken refusal, never a silent drop.
      this.deps.audit({ type: 'write', outcome: 'refused', reason: 'lock-timeout', topic: topicKey, principal, origin });
      return { ok: false, reply: 'Couldn\'t apply — this topic\'s session is mid-restart; say it again in a minute.', refusal: { reason: 'lock-timeout' } };
    }
    this.deps.audit({ type: 'write', outcome: 'refused', reason: 'internal-error', topic: topicKey, principal, origin });
    return { ok: false, reply: `Couldn't apply that change: ${err instanceof Error ? err.message : String(err)}.`, refusal: { reason: 'internal-error' } };
  }
}
