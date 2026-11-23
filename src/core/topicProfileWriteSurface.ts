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

import { assertProfileRuntimeGuard } from './ProfileRuntimeGuard.js';
import type { TopicProfileStore, TopicProfile } from './TopicProfileStore.js';
import { ProfileValidationRefusal, ProfileLockTimeoutError, ProfileDisplayConflictError, FlushRefusedError, parkedProfileVersion } from './TopicProfileStore.js';
import type { TopicProfileResolver } from './TopicProfileResolver.js';
import {
  validateProfileFields,
  type ProfilePatchInput,
  type ProfileValidationError,
  type ValidatedProfilePatch,
} from './topicProfileValidation.js';
import type { IntelligenceFramework } from './intelligenceProviderFactory.js';
import { FRAMEWORK_DISPLAY_NAMES, CLAUDE_CODE_FRAMEWORK } from './frameworkFacts.js';
import { CROSS_TOPIC_FIELDS } from './topicCreationProvenance.js';

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
    info: { frameworkChanged: boolean; origin: ProfileWriteOrigin; runtimeGuard?: () => boolean },
  ): void | Promise<void>;
}

export interface ProfileWriteResult {
  ok: boolean;
  /** The desired live/preview settings are durable; separate from runtime and delivery effects. */
  settingsSaved?: boolean;
  runtimeOutcome?: 'unknown';
  effectFailure?: 'post-save-callback';
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
  parkedVersion?: string;
}

export interface TopicProfileWriteSurfaceDeps {
  store: TopicProfileStore;
  resolver: TopicProfileResolver;
  /** Live gating knobs (enabled via resolveDevAgentGate; dryRun from config). */
  regime: () => ProfileWriteRegime;
  /** The topic's bound operator (§10.1) — null when none bound. */
  boundOperator: (topicKey: string) => { platform: string; uid: string } | null;
  /**
   * session-swap-any-conversation §3.4: may a TOKEN write (the dashboard, or the owner's phone
   * through its Face ID route) change this app or Slack conversation? Telegram keys never reach it
   * (their bound operator decides, as before). Absent ⇒ app and Slack token writes need a bound
   * operator, which they never have: today's refusal.
   */
  tokenMayWrite?: (topicKey: string) => { ok: true } | { ok: false; reply: string };
  /** Active `/local-model` binding (§5.2 — refuses cloud model pins). */
  localModelBinding: (topicKey: string) => { provider: string } | null;
  /**
   * §5.2(d) legacy respawn — today's exact `/route` behavior: drop the resume
   * UUID, kill, CONTINUATION respawn. Only invoked for framework-arm changes.
   * Returns respawned:false when the topic has no live session (write still
   * lands; takes effect at next spawn).
   */
  legacyFrameworkRespawn: (topicKey: string, runtimeGuard?: () => boolean) => Promise<{ respawned: boolean; error?: string }>;
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

const NEW_AXES = ['model', 'modelTier', 'thinkingMode', 'effort', 'escalationOverride', 'messageOriginDisplay'] as const;
const ALL_FIELDS = ['framework', ...NEW_AXES] as const;
const EXECUTION_FIELDS = ALL_FIELDS.filter(field => field !== 'messageOriginDisplay');
const DEFAULT_REAPPLY_COOLDOWN_MS = 600_000;
class ProposalChangedError extends Error {}

export class TopicProfileWriteSurface {
  private readonly deps: TopicProfileWriteSurfaceDeps;
  private readonly now: () => number;

  constructor(deps: TopicProfileWriteSurfaceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  // ── the main write path ───────────────────────────────────────────────────

  /** The live write regime (read-only; dashboard-door-model-controls §3.1 `regime`). */
  currentRegime(): ProfileWriteRegime {
    return this.deps.regime();
  }

  async applyWrite(req: {
    topicKey: string | number;
    patch: ProfilePatchInput;
    principal: ProfileWritePrincipal;
    origin: ProfileWriteOrigin;
    /** The caller's reply carries the disclosure-of-record (slash surfaces). */
    discloseInReply?: boolean;
    /** §10.1 propose-confirm provenance flag for the audit. */
    agentComposedPayload?: boolean;
    /** Server-held disclosure and eligibility fence; never read from HTTP bodies. */
    confirmation?: { echo: string; name?: string; eligible: () => boolean; validAtCommit?: () => boolean; onSaved?: (result: ProfileWriteResult) => void };
    /** Trusted HTTP cosmetic compare-and-set; store checks under its lock. */
    expectedDisplayRevision?: string;
    /**
     * identity-security-creation-provenance v5: the owner confirmed this exact change in another
     * conversation (the propose lane's `confirmIn`), and the caller re-checked that this topic is
     * eligible (crossTopicEligible). Lets an operator principal write a topic with no bound operator.
     */
    crossTopicConfirm?: { sourceTopicId: number };
  }): Promise<ProfileWriteResult> {
    const topicKey = String(req.topicKey);
    let regime = { ...this.deps.regime() };

    // ── §10.1 principal / bound-operator gate ──────────────────────────────
    if (req.crossTopicConfirm) {
      // Defense in depth: the route and write surface share the same owner-confirmable fields.
      const outside = Object.keys(req.patch).filter((k) => !CROSS_TOPIC_FIELDS.includes(k));
      if (outside.length) {
        this.deps.audit({ type: 'write', outcome: 'refused', reason: 'cross-topic-field', topic: topicKey, fields: outside, origin: req.origin });
        return { ok: false, reply: 'From another conversation I can change only the engine, model, model tier, thinking mode or effort.', refusal: { reason: 'cross-topic-field' } };
      }
    }
    const authRefusal = this.authorize(topicKey, req.principal, req.origin, req.crossTopicConfirm);
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
    let patch = validated.patch;

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
    const makePlan = () => {
      const frameworkArm: ValidatedProfilePatch = {};
      if (patch.framework !== undefined) frameworkArm.framework = patch.framework;

      const liveNewAxes: ValidatedProfilePatch = {};
      const shadowNewAxes: ValidatedProfilePatch = {};
      const refusedFields: string[] = [];
      for (const field of NEW_AXES) {
        const value = patch[field];
        if (value === undefined) continue;
        if (field === 'messageOriginDisplay' || value === null) {
          // Cosmetic presentation is independent of model-profile rollout.
          // §5.2(b): clearing a pin is a recovery write — permitted (LIVE) in
          // every regime, never shadowed.
          (liveNewAxes as Record<string, unknown>)[field] = value;
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
      return { livePatch, liveNewAxes, shadowNewAxes, refusedFields, frameworkChanged, liveFields, shadowFields };
    };
    let plan = makePlan();

    if (!req.confirmation && plan.liveFields.length === 0 && plan.shadowFields.length === 0) {
      if (plan.refusedFields.length > 0) {
        // §5.2 disabled-flag semantics: NEW operator pins are refused while
        // the feature is off (reads still honor existing pins).
        this.deps.audit({
          type: 'write', outcome: 'refused', reason: 'disabled',
          fields: plan.refusedFields, topic: topicKey, principal: updatedBy, origin: req.origin,
        });
        return {
          ok: false,
          reply: `The ${plan.refusedFields.join('/')} control isn't enabled on this agent — the profile is unchanged.`,
          refusal: { reason: 'disabled' },
          refusedFields: plan.refusedFields,
        };
      }
      return { ok: false, reply: 'Nothing to change — say what you want set on this topic.', refusal: { reason: 'empty-patch' } };
    }

    let before = this.profileSnapshot(topicKey);
    let supersededParked = false;
    let changed = false;
    let savedOutcome: ProfileWriteResult | undefined;
    const captureSaved = (shadowed: string[]) => {
      savedOutcome = { ok: true, settingsSaved: true,
        reply: plan.liveFields.length ? 'The settings were saved. I could not confirm whether the running conversation was updated.'
          : 'The preview was recorded. It did not change the running conversation.',
        appliedLive: [...plan.liveFields], shadowed: [...shadowed], refusedFields: [...plan.refusedFields],
        supersededParked };
      req.confirmation?.onSaved?.(savedOutcome);
    };
    try {
      if (plan.liveFields.length > 0 || req.confirmation) {
        try {
          const result = await this.deps.store.mutate(
            topicKey,
            { ...plan.livePatch, updatedBy },
            // §5.1 cadence: every accepted write here is individually disclosed
            // (no §8 coalescing window until the orchestrator is live).
            { shiftPrevious: true, expectedDisplayRevision: req.expectedDisplayRevision,
              ...(req.confirmation ? {
                prepare: () => {
                  regime = { ...this.deps.regime() };
                  const fresh = this.renderProposalEcho(topicKey, req.patch, req.confirmation!.name, regime);
                  if (!req.confirmation!.eligible() || !fresh.ok || fresh.echo !== req.confirmation!.echo) throw new ProposalChangedError();
                  patch = fresh.patch;
                  before = this.profileSnapshot(topicKey);
                  plan = makePlan();
                  if (!plan.liveFields.length && !plan.shadowFields.length) throw new ProposalChangedError();
                  return { patch: { ...plan.livePatch, updatedBy },
                    ...(plan.shadowFields.length ? { shadow: plan.shadowNewAxes } : {}) };
                },
                beforeCommit: () => {
                  if (!req.confirmation!.eligible() || req.confirmation!.validAtCommit?.() === false) throw new ProposalChangedError();
                },
              } : {}),
            },
          );
          changed = result.changed;
          supersededParked = result.supersededParked;
          captureSaved(req.confirmation ? plan.shadowFields : []);
        } catch (err) {
          if (savedOutcome) throw err;
          if (err instanceof ProposalChangedError) return { ok: false,
            reply: 'The settings or ownership changed after that question. I need to send a fresh question before changing anything.',
            refusal: { reason: 'proposal-changed' } };
          return this.writeFailure(err, topicKey, updatedBy, req.origin);
        }
        // §5.3: the mutate's flush durably landed (mutate resolved) — a local
        // operator/HTTP write cancels any pending transfer-pull REPLACE.
        if (plan.liveFields.length > 0) this.notifyLocalWriteDurable(topicKey, req.origin);
      }

      if (plan.shadowFields.length > 0 && !req.confirmation) {
        try {
          // §14: the dry-run shadow records the intent; resolution never reads it.
          const current = this.deps.store.get(topicKey)?.intendedProfile?.fields ?? {};
          await this.deps.store.setShadow(topicKey, { ...current, ...plan.shadowNewAxes }, updatedBy);
          captureSaved(plan.shadowFields);
        } catch (err) {
          if (savedOutcome) throw err;
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
        ...(req.crossTopicConfirm ? { crossTopic: true, authorizedBy: `owner-confirmed-in:${req.crossTopicConfirm.sourceTopicId}` } : {}),
        appliedLive: plan.liveFields,
        shadowed: plan.shadowFields,
        refusedFields: plan.refusedFields,
        old: before,
        new: after,
        ...(supersededParked ? { supersededParked: true } : {}),
      }) ?? new Date(this.now()).toISOString();

      if (req.confirmation && !req.confirmation.eligible()) {
        const reply = 'The settings were saved. I did not start or restart the conversation because I could no longer verify permission to do that.';
        if (!req.discloseInReply) await this.deps.disclose(topicKey, reply).catch(() => {});
        return { ok: true, settingsSaved: true, reply, appliedLive: plan.liveFields, shadowed: plan.shadowFields };
      }

      // ── application arm ─────────────────────────────────────────────────────
      const fullyLive = regime.enabled && !regime.dryRun;
      let legacyRespawned = false;
      let respawnNote = '';
      if (plan.frameworkChanged && changed) {
        if (fullyLive && this.deps.orchestrator) {
          // §8 fully-live orchestration (debounce, busy-refusal, parking).
          await this.deps.orchestrator.onProfileWrite(topicKey, { frameworkChanged: true, origin: req.origin, ...(req.confirmation ? { runtimeGuard: req.confirmation.eligible } : {}) });
          respawnNote = ' Applying shortly (waiting for an idle moment).';
        } else {
          // §5.2(d): the legacy path serves the switch byte-for-byte — immediate
          // kill + CONTINUATION respawn, resume-UUID drop. In the fully-live
          // regime with no orchestrator wired this is the keep-working fallback.
          if (fullyLive) this.deps.audit({ type: 'orchestration-unavailable', topic: topicKey });
          assertProfileRuntimeGuard(req.confirmation?.eligible);
          const respawn = await this.deps.legacyFrameworkRespawn(topicKey, req.confirmation?.eligible);
          legacyRespawned = respawn.respawned;
          respawnNote = respawn.respawned
            ? ' Session respawned — recent history carries over; the full transcript can\'t follow across frameworks.'
            : respawn.error
              ? ` Persisted, but the respawn failed: ${respawn.error} — it takes effect on this topic's next session.`
              : ' Takes effect when a session starts for this topic.';
        }
      } else if (Object.keys(plan.liveNewAxes).some(field => field !== 'messageOriginDisplay') && changed) {
        if (fullyLive && this.deps.orchestrator) {
          await this.deps.orchestrator.onProfileWrite(topicKey, { frameworkChanged: false, origin: req.origin, ...(req.confirmation ? { runtimeGuard: req.confirmation.eligible } : {}) });
          respawnNote = ' Applying shortly (waiting for an idle moment).';
        } else {
          // No profile-triggered kill outside the fully-live orchestration —
          // told out loud (§5.2(b) precedent: apply-at-next-spawn, boot-sweep
          // reconcile is the backstop).
          respawnNote = ' Takes effect at this topic\'s next session restart.';
        }
      } else if (plan.liveNewAxes.messageOriginDisplay !== undefined && changed) {
        respawnNote = ' Applies to newly prepared messages; origin recording continues.';
      }

      // ── §8 disclosure (delta-carrying, audit-stamped) ───────────────────────
      const parts: string[] = [];
      if (plan.liveFields.length > 0) {
        parts.push(`${this.renderDelta(before, after)}${respawnNote}`);
      }
      if (plan.shadowFields.length > 0) {
        parts.push(
          `[dry-run] recorded as an intent, not applied: ${plan.shadowFields.map(f => `${f} → ${String((plan.shadowNewAxes as Record<string, unknown>)[f])}`).join(', ')} — the new profile machinery is in its observation canary on this agent.`,
        );
      }
      if (plan.refusedFields.length > 0) {
        parts.push(`Not applied (the ${plan.refusedFields.join('/')} control isn't enabled on this agent): re-issue once it's on.`);
      }
      if (supersededParked) {
        parts.push('Your previously parked pin was superseded by this change.');
      }
      if (plan.liveFields.length > 0 && !changed && plan.shadowFields.length === 0 && plan.refusedFields.length === 0) {
        return { ok: true, settingsSaved: true, noop: true, reply: 'Already set — nothing to change.', appliedLive: [] };
      }

      const reply = `${parts.join('\n')}\n(profile change ${seq}${req.origin === 'http' ? ', via API' : ''})`;
      if (!req.discloseInReply && (plan.liveFields.length > 0 || plan.shadowFields.length > 0)) {
        // §8: token-trust/HTTP writes (and any caller whose reply isn't the
        // topic conversation) post the disclosure to the topic itself.
        await this.deps.disclose(topicKey, reply).catch(() => { /* best-effort */ });
      }

      return {
        ok: true,
        settingsSaved: true,
        reply,
        appliedLive: plan.liveFields,
        shadowed: plan.shadowFields,
        refusedFields: plan.refusedFields,
        supersededParked,
        legacyRespawned,
        noop: plan.liveFields.length > 0 ? !changed : undefined,
      };
    } catch (error) {
      if (!savedOutcome) return this.writeFailure(error, topicKey, updatedBy, req.origin);
      // A post-save callback cannot turn a durable write into "nothing changed".
      console.error('[topic-profile-post-save-callback-failed]', JSON.stringify({ topic: topicKey, origin: req.origin }));
      return { ...savedOutcome, runtimeOutcome: 'unknown', effectFailure: 'post-save-callback' };
    }
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
    for (const field of EXECUTION_FIELDS) {
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

    const reply = `${note} Execution settings are back on defaults; origin display preferences are unchanged.\n(profile change ${seq})`;
    if (!req.discloseInReply) await this.deps.disclose(topicKey, reply).catch(() => {});
    return { ok: true, reply, appliedLive: [...EXECUTION_FIELDS] };
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
    expectedParkedVersion?: string;
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

    const observedVersion = parkedProfileVersion(parked)!;
    if (req.expectedParkedVersion !== undefined && req.expectedParkedVersion !== observedVersion) return {
      ok: false, reply: 'The saved recovery settings changed after that question. I need to ask again before applying them.',
      refusal: { reason: 'parked-profile-changed' },
    };
    const cooldownMs = this.deps.reapplyCooldownMs ?? DEFAULT_REAPPLY_COOLDOWN_MS;
    const parkedAgeMs = this.now() - Date.parse(parked.parkedAt);
    if (!req.confirmed && Number.isFinite(parkedAgeMs) && parkedAgeMs < cooldownMs) {
      const echo = `This exact profile failed to launch ${Math.max(1, Math.round(parkedAgeMs / 60_000))} minute(s) ago (${parked.reason}) — apply it anyway?`;
      this.deps.audit({ type: 'reapply', outcome: 'needs-confirm', topic: topicKey, principal: updatedBy, origin: req.origin });
      return { ok: false, needsConfirm: true, parkedVersion: observedVersion, reply: echo, refusal: { reason: 'cooldown-confirm-required' } };
    }

    const patch: ValidatedProfilePatch = {};
    for (const field of EXECUTION_FIELDS) {
      (patch as Record<string, unknown>)[field] = (parked.profile as unknown as Record<string, unknown>)[field] ?? null;
    }
    const frameworkChanged = (this.deps.store.resolve(topicKey)?.framework ?? null) !== (parked.profile.framework ?? null);

    const before = this.profileSnapshot(topicKey);
    try {
      // The operator-attributed mutate atomically clears the parked state +
      // breaker counter (store supersession discipline).
      await this.deps.store.mutate(topicKey, { ...patch, updatedBy }, { shiftPrevious: true,
        beforeCommit: () => { if (parkedProfileVersion(this.deps.store.parkedFor(topicKey)) !== observedVersion) throw new ProposalChangedError(); },
      });
    } catch (err) {
      if (err instanceof ProposalChangedError) return { ok: false,
        reply: 'The saved recovery settings changed after that question. I need to ask again before applying them.',
        refusal: { reason: 'parked-profile-changed' } };
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
    conversationName?: string,
    regimeSnapshot?: ProfileWriteRegime,
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
    const regime = regimeSnapshot ?? this.deps.regime();
    const name = conversationName ? `“${conversationName}”` : 'this conversation';
    const lines: string[] = [`Change how ${name} runs?`];
    const labels: Record<string, string> = { model: 'Model', modelTier: 'Model level', thinkingMode: 'Thinking level',
      effort: 'Reasoning effort', escalationOverride: 'Automatic model upgrades', messageOriginDisplay: 'Message signatures' };
    for (const field of ALL_FIELDS) {
      const value = (validated.patch as Record<string, unknown>)[field];
      if (value === undefined) continue;
      const rendered = value === null ? 'cleared' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (field === 'framework') {
        const engine = value === null ? 'the default engine' : FRAMEWORK_DISPLAY_NAMES[value as IntelligenceFramework] ?? rendered;
        lines.push(`Use ${engine} for ${name}.`);
        lines.push(regime.enabled && !regime.dryRun && this.deps.orchestrator
          ? 'If a session is running, it will wait for an idle moment before restarting with a summary of recent work. Otherwise, this engine applies when the conversation next starts. The full transcript may not carry over.'
          : 'If a session is running, it will restart with a summary of recent work. Otherwise, this engine applies when the conversation next starts. The full transcript may not carry over.');
        if (regime.enabled && !regime.dryRun && resolved.framework === CLAUDE_CODE_FRAMEWORK && value !== null && value !== CLAUDE_CODE_FRAMEWORK) lines.push('Automatic upgrades to a stronger model for heavy work will no longer be available in this conversation.');
      } else if (field === 'messageOriginDisplay') {
        const signatureLabels: Record<string, string> = { enabled: 'Message signatures', machine: 'Machine name', harness: 'Engine name', model: 'Model name' };
        lines.push(value === null ? 'Return message signatures to the defaults.'
          : Object.entries(value as Record<string, boolean>).map(([key, enabled]) => `${signatureLabels[key]}: ${enabled ? 'show' : 'hide'}.`).join(' '));
        lines.push('This affects new messages; origin recording continues.');
      } else if (value === null) {
        lines.push(`${labels[field]}: return to the default setting after confirmation.`);
      } else if (!regime.enabled) {
        lines.push(`${labels[field]}: ${rendered} cannot be applied because this setting is not enabled.`);
      } else if (regime.dryRun) {
        lines.push(`${labels[field]}: ${rendered} will be recorded for preview only. It will not change the running model.`);
      } else {
        lines.push(`${labels[field]}: ${rendered} will apply after confirmation, when the conversation can restart safely.`);
      }
    }
    if (lines.length === 1) return { ok: false, reply: 'Nothing to propose — the delta is empty.' };
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
    const display = entry?.current?.messageOriginDisplay;
    lines.push(display == null ? 'Message signature display inherits agent settings; origin recording continues.'
      : `Message signature display: ${Object.entries(display).map(([field, value]) => `${field} ${value ? 'shown' : 'hidden'}`).join(', ')}. Unspecified fields inherit agent settings; origin recording continues.`);
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
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
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
    crossTopicConfirm?: { sourceTopicId: number },
  ): ProfileWriteResult | null {
    const bound = this.deps.boundOperator(topicKey);
    if (principal.kind === 'token') {
      // session-swap-any-conversation §3.4: app and Slack conversations never get a bound operator;
      // a token write there is the owner's dashboard or phone, decided by the conversation's own record.
      if (!bound && !/^\d+$/.test(topicKey) && this.deps.tokenMayWrite) {
        const may = this.deps.tokenMayWrite(topicKey);
        if (may.ok) return null;
        this.deps.audit({ type: 'write', outcome: 'refused', reason: 'no-bound-operator', topic: topicKey, principal: 'api-token', origin });
        return { ok: false, reply: may.reply, refusal: { reason: 'no-bound-operator' } };
      }
      // §10.1: token-trust still refuses writes to topics with no bound operator.
      if (!bound) {
        this.deps.audit({ type: 'write', outcome: 'refused', reason: 'no-bound-operator', topic: topicKey, principal: 'api-token', origin });
        return {
          ok: false,
          reply: 'Send one message in this topic first, then switch. The topic only learns who its operator is from that first message.',
          refusal: { reason: 'no-bound-operator' },
        };
      }
      return null;
    }
    if (!bound && crossTopicConfirm && /^\d+$/.test(topicKey)) {
      // The owner's live yes in the source conversation; eligibility re-checked by the caller.
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
      return entries.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ');
    };
    return `Topic profile — was: ${renderSide(before)} → now: ${renderSide(after)}`;
  }

  private writeFailure(
    err: unknown,
    topicKey: string,
    principal: string,
    origin: ProfileWriteOrigin,
  ): ProfileWriteResult {
    if (err instanceof ProfileDisplayConflictError) {
      this.deps.audit({ type: 'write', outcome: 'refused', reason: 'display-conflict', topic: topicKey, principal, origin });
      return { ok: false, reply: err.message, refusal: { reason: 'display-conflict' } };
    }
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
