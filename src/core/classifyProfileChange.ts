/**
 * classifyProfileChange — the §7 respawn classifier & swap-quality matrix
 * (TOPIC-PROFILE-SPEC). Pure in-memory comparison, NO I/O.
 *
 * Picks the gentlest swap method for a profile change and states the honest
 * expected context loss — including the contingencies (FABLE canary, Claude
 * resume-UUID capture, Codex rollout-id capture, unverified thinking-toggle
 * resume, unverified cross-model resume). The none-loss rows require HOOK
 * provenance / fence-validated capture; anything weaker classifies to the
 * disclosed-loss row — a wrong-conversation resume is worse than disclosed
 * loss (§8).
 *
 * Classification chooses the METHOD only. Idle is a precondition RE-CHECKED
 * at kill time inside the per-topic lock (§8 TOCTOU rule) — an unconfirmed
 * idle read here fails toward kill+--resume (the safe, lossless direction,
 * never an in-flight injection); at kill time unconfirmed is treated as busy.
 */

import type { TopicProfile } from './TopicProfileStore.js';

export type SwapMethod = 'in-flight' | 'resume' | 'continuation' | 'none';
export type ExpectedLoss = 'none' | 'recent-only';
export type IdleReading = 'confirmed-idle' | 'busy' | 'unconfirmed';

export interface ProfileSessionState {
  /** False for a dormant topic (no live session) — change applies at next spawn. */
  exists: boolean;
  /** FABLE capture-pane idle confirmation (three-valued, §8). */
  idle: IdleReading;
  /** Pane-idle is not task-done: an active autonomous/time-boxed run is busy (§8). */
  autonomousActive: boolean;
  /** Protected sessions are never profile-killed (§8). */
  isProtected: boolean;
  /**
   * §8 pre-kill predicate: the live session has a hook-reported
   * claudeSessionId (or an existing HOOK-provenance resume entry) — not
   * merely "an entry exists" (mtime-fallback entries classify as
   * CONTINUATION-class loss).
   */
  claudeResumeReady: boolean;
  /** A fence-validated codex rollout-id is captured for this topic (§7). */
  codexRolloutCaptured: boolean;
  /**
   * §14 runtime canary: a durable recent-confirmation marker (TTL) shows the
   * FABLE in-flight swap actually confirming. No recent confirmation ⇒ the
   * in-flight row is unavailable.
   */
  inFlightSwapConfirmedRecently: boolean;
  /** §6 — thinking off↔on toggle verified benign across --resume on the live CLI. */
  thinkingOffOnResumeVerified: boolean;
  /** §6 — thinking budget LEVEL change verified across --resume (round-4: same contingent cell). */
  thinkingLevelResumeVerified: boolean;
  /** §6 — MODEL change across --resume verified (round-4: wedge-class risk). */
  crossModelResumeVerified: boolean;
  /** §6 contingency — a launch-time thinking control exists for claude-code at all. */
  claudeThinkingControlAvailable: boolean;
}

export interface ProfileChangeClassification {
  requiresRespawn: boolean;
  swapMethod: SwapMethod;
  expectedLoss: ExpectedLoss;
  reason: string;
  /**
   * True when the method is kill-bearing and the session is not
   * confirmed-idle (busy/unconfirmed/autonomous) — §8 defers until idle.
   */
  deferUntilIdle: boolean;
  /**
   * §7 busy framework switch: refuse-or-confirm, never a silent mid-work
   * kill. (deferUntilIdle is also true; this adds the explicit-confirm arm.)
   */
  refuseOrConfirm: boolean;
  /** Protected sessions defer regardless of idle; 'switch now' never overrides (§8). */
  protectedDeferral: boolean;
  /**
   * True when the respawn is a FRESH spawn (framework switch / unverified
   * resume path) — the §8 kill path must PARK both resume stores' entries
   * before the kill and suppress the save-on-kill listeners.
   */
  freshRespawn: boolean;
  /** Which profile axes changed (for disclosure text). */
  changedFields: string[];
}

const AXES = ['framework', 'model', 'modelTier', 'thinkingMode', 'effort', 'escalationOverride'] as const;

function isOffOnToggle(a: TopicProfile | null, b: TopicProfile | null): boolean {
  const oldMode = a?.thinkingMode ?? null;
  const newMode = b?.thinkingMode ?? null;
  if (oldMode === newMode) return false;
  return oldMode === 'off' || newMode === 'off' || oldMode === null || newMode === null;
}

/** Classify a profile change against the live-session state. Pure, no I/O. */
export function classifyProfileChange(
  oldProfile: TopicProfile | null,
  newProfile: TopicProfile | null,
  session: ProfileSessionState,
): ProfileChangeClassification {
  const changedFields = AXES.filter(
    (f) => (oldProfile?.[f] ?? null) !== (newProfile?.[f] ?? null),
  );

  const base = {
    deferUntilIdle: false,
    refuseOrConfirm: false,
    protectedDeferral: false,
    freshRespawn: false,
    changedFields,
  };

  // §8 net-unchanged / no-effective-delta → zero respawns.
  if (changedFields.length === 0) {
    return {
      ...base,
      requiresRespawn: false,
      swapMethod: 'none',
      expectedLoss: 'none',
      reason: 'no effective profile change',
    };
  }

  // escalationOverride alone never moves a live session — it is consulted by
  // the escalation authority at its own decision points (§9).
  const onlyEscalationOverride = changedFields.length === 1 && changedFields[0] === 'escalationOverride';
  if (onlyEscalationOverride) {
    return {
      ...base,
      requiresRespawn: false,
      swapMethod: 'none',
      expectedLoss: 'none',
      reason: 'escalation-override change — applies at the next escalation decision, no respawn',
    };
  }

  // Dormant topic: the pin applies at the next natural spawn.
  if (!session.exists) {
    return {
      ...base,
      requiresRespawn: false,
      swapMethod: 'none',
      expectedLoss: 'none',
      reason: 'no live session — profile applies at the next session start',
    };
  }

  const oldFramework = oldProfile?.framework ?? 'claude-code';
  const newFramework = newProfile?.framework ?? oldFramework;
  const frameworkSwitch = changedFields.includes('framework') && oldFramework !== newFramework;
  const confirmedIdle = session.idle === 'confirmed-idle' && !session.autonomousActive;
  const busyish = !confirmedIdle;

  const killGuards = (cls: Omit<ProfileChangeClassification, 'deferUntilIdle' | 'protectedDeferral'>) => ({
    ...cls,
    deferUntilIdle: busyish,
    protectedDeferral: session.isProtected,
  });

  // ── framework switch (the cold-rebuild path) ──────────────────────────
  if (frameworkSwitch) {
    if (busyish) {
      // §7 busy row: refuse-or-confirm — never a silent mid-work kill.
      return {
        ...base,
        requiresRespawn: true,
        swapMethod: 'continuation',
        expectedLoss: 'recent-only',
        reason:
          'framework switch while the session is mid-task — refused until idle (or an explicit "switch now")',
        deferUntilIdle: true,
        refuseOrConfirm: true,
        protectedDeferral: session.isProtected,
        freshRespawn: true,
      };
    }
    return killGuards({
      ...base,
      requiresRespawn: true,
      swapMethod: 'continuation',
      expectedLoss: 'recent-only',
      reason:
        'framework switch — the full transcript cannot follow across frameworks; CONTINUATION carries recent history + memory',
      refuseOrConfirm: false,
      freshRespawn: true,
    });
  }

  // ── same-framework changes ────────────────────────────────────────────
  const modelChanged = changedFields.includes('model');
  const tierChanged = changedFields.includes('modelTier');
  const thinkingChanged = changedFields.includes('thinkingMode');
  const effortChanged = changedFields.includes('effort');

  if (newFramework === 'codex-cli') {
    // §7 Codex rows: none-loss IFF the fence-validated rollout-id is
    // captured on THIS machine; else CONTINUATION, recent-only, disclosed.
    if (session.codexRolloutCaptured) {
      return killGuards({
        ...base,
        requiresRespawn: true,
        swapMethod: 'resume',
        expectedLoss: 'none',
        reason: 'codex change with a fence-validated rollout-id — kill + codex resume <rollout-id>',
        refuseOrConfirm: false,
        freshRespawn: false,
      });
    }
    return killGuards({
      ...base,
      requiresRespawn: true,
      swapMethod: 'continuation',
      expectedLoss: 'recent-only',
      reason: 'codex change with NO captured rollout-id — fresh spawn, recent history only (disclosed)',
      refuseOrConfirm: false,
      freshRespawn: true,
    });
  }

  if (newFramework !== 'claude-code') {
    // gemini/pi: no resume verification surface wired — honest CONTINUATION.
    return killGuards({
      ...base,
      requiresRespawn: true,
      swapMethod: 'continuation',
      expectedLoss: 'recent-only',
      reason: `${newFramework} profile change — no verified resume path; fresh spawn, recent history only`,
      refuseOrConfirm: false,
      freshRespawn: true,
    });
  }

  // claude-code rows.

  // thinkingMode with NO usable launch-time control: disclosed no-op (§6).
  if (thinkingChanged && !modelChanged && !tierChanged && !session.claudeThinkingControlAvailable) {
    return {
      ...base,
      requiresRespawn: false,
      swapMethod: 'none',
      expectedLoss: 'none',
      reason:
        'claude thinking-mode control is not verifiable on the installed CLI — recorded, but a disclosed no-op until it is',
    };
  }

  // modelTier pin (in-flight eligible row).
  if (tierChanged && !modelChanged && !thinkingChanged) {
    if (session.idle === 'confirmed-idle' && !session.autonomousActive && session.inFlightSwapConfirmedRecently) {
      return killGuards({
        ...base,
        requiresRespawn: false,
        swapMethod: 'in-flight',
        expectedLoss: 'none',
        reason: 'tier pin on a confirmed-idle claude session with a recently-confirmed swap canary — in-flight /model swap',
        refuseOrConfirm: false,
        freshRespawn: false,
      });
    }
    // Canary not recently confirmed, or idle unconfirmed/busy: fail toward
    // kill+--resume (still none-loss, brief respawn). Cross-model resume
    // applies — a tier change IS a model change at the transcript level.
    if (!session.crossModelResumeVerified) {
      return killGuards({
        ...base,
        requiresRespawn: true,
        swapMethod: 'continuation',
        expectedLoss: 'recent-only',
        reason: 'tier change without verified cross-model resume — fresh spawn (resuming across models risks the thinking-block wedge)',
        refuseOrConfirm: false,
        freshRespawn: true,
      });
    }
    if (!session.claudeResumeReady) {
      return killGuards({
        ...base,
        requiresRespawn: true,
        swapMethod: 'continuation',
        expectedLoss: 'recent-only',
        reason: 'tier change with no hook-captured resume UUID — fresh spawn, recent history only (disclosed)',
        refuseOrConfirm: false,
        freshRespawn: true,
      });
    }
    return killGuards({
      ...base,
      requiresRespawn: true,
      swapMethod: 'resume',
      expectedLoss: 'none',
      reason: 'tier change — kill + claude --resume (in-flight row unavailable)',
      refuseOrConfirm: false,
      freshRespawn: false,
    });
  }

  // Explicit model change (round-4: cross-model resume is wedge-class until verified).
  if (modelChanged || tierChanged) {
    if (!session.crossModelResumeVerified) {
      return killGuards({
        ...base,
        requiresRespawn: true,
        swapMethod: 'continuation',
        expectedLoss: 'recent-only',
        reason:
          'model change without verified cross-model resume — fresh spawn (resuming an old-model transcript risks the thinking-block wedge)',
        refuseOrConfirm: false,
        freshRespawn: true,
      });
    }
    if (!session.claudeResumeReady) {
      return killGuards({
        ...base,
        requiresRespawn: true,
        swapMethod: 'continuation',
        expectedLoss: 'recent-only',
        reason: 'model change with no hook-captured resume UUID — fresh spawn, recent history only (disclosed)',
        refuseOrConfirm: false,
        freshRespawn: true,
      });
    }
    return killGuards({
      ...base,
      requiresRespawn: true,
      swapMethod: 'resume',
      expectedLoss: 'none',
      reason: 'model change — kill + claude --resume (full transcript)',
      refuseOrConfirm: false,
      freshRespawn: false,
    });
  }

  // effort-only change (claude). --effort is a pure LAUNCH-TIME flag: it does
  // not touch the thinking-block transcript shape, so a kill + claude --resume
  // is benign (none-loss when a resume UUID was hook-captured; else a disclosed
  // fresh spawn with recent-only history). Its OWN row — without this, an
  // effort-only change falls through to the thinkingMode block and reports a
  // wrong reason gated on the wrong (thinking) verification flag (second-pass
  // review finding, 2026-06-12). Combined effort+model/tier/thinking changes are
  // already handled by those rows above (their respawn carries the new --effort).
  if (effortChanged && !modelChanged && !tierChanged && !thinkingChanged) {
    if (!session.claudeResumeReady) {
      return killGuards({
        ...base,
        requiresRespawn: true,
        swapMethod: 'continuation',
        expectedLoss: 'recent-only',
        reason: 'effort change with no hook-captured resume UUID — fresh spawn, recent history only (disclosed)',
        refuseOrConfirm: false,
        freshRespawn: true,
      });
    }
    return killGuards({
      ...base,
      requiresRespawn: true,
      swapMethod: 'resume',
      expectedLoss: 'none',
      reason: 'effort change — kill + claude --resume (--effort is a launch-time flag; benign across resume)',
      refuseOrConfirm: false,
      freshRespawn: false,
    });
  }

  // thinkingMode change (claude, control available).
  const offOn = isOffOnToggle(oldProfile, newProfile);
  const toggleVerified = offOn ? session.thinkingOffOnResumeVerified : session.thinkingLevelResumeVerified;
  if (!toggleVerified) {
    return killGuards({
      ...base,
      requiresRespawn: true,
      swapMethod: 'continuation',
      expectedLoss: 'recent-only',
      reason: offOn
        ? 'thinking off↔on toggle unverified across --resume — fresh spawn (the toggle is the documented wedge class)'
        : 'thinking level change unverified across --resume — fresh spawn (disclosed)',
      refuseOrConfirm: false,
      freshRespawn: true,
    });
  }
  if (!session.claudeResumeReady) {
    return killGuards({
      ...base,
      requiresRespawn: true,
      swapMethod: 'continuation',
      expectedLoss: 'recent-only',
      reason: 'thinking change with no hook-captured resume UUID — fresh spawn, recent history only (disclosed)',
      refuseOrConfirm: false,
      freshRespawn: true,
    });
  }
  return killGuards({
    ...base,
    requiresRespawn: true,
    swapMethod: 'resume',
    expectedLoss: 'none',
    reason: 'thinking change — kill + claude --resume (verified benign on the live CLI)',
    refuseOrConfirm: false,
    freshRespawn: false,
  });
}
