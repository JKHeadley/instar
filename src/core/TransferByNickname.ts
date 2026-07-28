/**
 * TransferByNickname — the pure planner behind the headline "move this to
 * <nickname>" mid-conversation swap (Multi-Machine Session Pool §L4 "Topic
 * Placement Updates" + §L5). It turns a recognized NicknameCommand into a gated,
 * validated TransferPlan: resolve the nickname → machineId, enforce the rate limit,
 * the confirmation gate (offline target / mid-reply), and the already-there no-op.
 * Per "Structure > Willpower" a transfer is high-impact, so this is NOT free-text
 * inference — it operates on an ALREADY-recognized command + the registry state,
 * and an unknown/ambiguous nickname is REJECTED (listing valid nicknames), never
 * silently mis-routed.
 */

import type { NicknameCommand } from './NicknameCommand.js';

export interface TransferByNicknameState {
  /** Resolve a nickname → machineId (case-insensitive exact match), or null if unknown. */
  resolveNickname: (nickname: string) => string | null;
  /** The full set of valid nicknames (returned on an unknown-nickname rejection). */
  validNicknames: () => string[];
  isOnline: (machineId: string) => boolean;
  currentOwnerOf: (sessionKey: string) => string | null;
  /** Is the session mid-reply (a turn in flight)? Confirmation is required to interrupt it. */
  isMidReply: (sessionKey: string) => boolean;
  /**
   * The machine the topic is currently PINNED to (preferredMachine), or null if
   * unpinned. Optional for backward compatibility — when absent, only the
   * current-owner check can satisfy the already-there no-op.
   */
  currentPinOf?: (sessionKey: string) => string | null;
  /** When the topic last had a placement update (for the rate limit), or null. */
  lastPlacementUpdateAt: (sessionKey: string) => number | null;
  now: () => number;
  /** Minimum ms between placement updates per topic. Default 10000. */
  minUpdateIntervalMs?: number;
  /**
   * WS1.4 (MULTI-MACHINE-SEAMLESSNESS-SPEC): a LIVE autonomous run on this
   * topic on THIS machine, or null when none. Evaluated FIRST among the
   * consent gates (before offline/mid-reply) — moving a topic out from under
   * an in-flight autonomous run suspends real work, so it always requires
   * explicit confirmation. Optional for backward compatibility.
   */
  autonomousRunActive?: (sessionKey: string) => { goal: string | null; remainingMinutes: number | null } | null;
}

export type TransferPlanAction = 'transfer' | 'noop' | 'confirm-required' | 'reject';

export interface TransferPlan {
  action: TransferPlanAction;
  sessionKey: string;
  /** Resolved target machine (present for transfer / confirm-required / noop). */
  targetMachine?: string;
  /** Set the topic's preferredMachine + pinned:true (a hard pin — §L4). */
  setPin?: boolean;
  /** Human-facing confirmation prompt (action === 'confirm-required'). */
  confirmationPrompt?: string;
  /** Rejection reason (action === 'reject'). */
  rejectReason?: 'unknown-machine-nickname' | 'rate-limited';
  /** On unknown-nickname: the valid nicknames to surface to the user. */
  validNicknames?: string[];
  detail?: string;
}

const DEFAULT_MIN_UPDATE_INTERVAL_MS = 10000;

/**
 * Plan a transfer-by-nickname. Pure over (command, state). Both "move this to
 * <nick>" and "run this on <nick>" set a hard pin (pinned:true) per §L4; the only
 * intent difference is cosmetic. Confirmation is required when the target is offline,
 * or when it differs from the current owner AND the session is mid-reply (§L4 line 456).
 */
export function planTransferByNickname(command: NicknameCommand, state: TransferByNicknameState, sessionKey: string): TransferPlan {
  const target = state.resolveNickname(command.nickname);
  if (!target) {
    return { action: 'reject', sessionKey, rejectReason: 'unknown-machine-nickname', validNicknames: state.validNicknames(), detail: command.nickname };
  }

  const owner = state.currentOwnerOf(sessionKey);

  // Idempotency BEFORE the rate limit: a repeat "move to X" when the topic is
  // already ON X — or already PINNED to X (the move landed but ownership hasn't
  // re-placed yet) — is a duplicate of an already-satisfied request. It must
  // read as "already there", never as a rate-limit rejection. (2026-06-05
  // incident: a retried/replayed "move to laptop" hit the cooldown and the user
  // was told "I can't move this right now (rate-limited)" seconds after
  // "Moving this conversation to Laptop" — for ONE request that had already
  // succeeded.)
  if (owner === target) {
    return { action: 'noop', sessionKey, targetMachine: target, setPin: true, detail: 'already-on-target' };
  }
  if ((state.currentPinOf?.(sessionKey) ?? null) === target) {
    return { action: 'noop', sessionKey, targetMachine: target, setPin: true, detail: 'already-pinned-to-target' };
  }

  // Rate limit — at most one ACTUAL placement change per topic per interval
  // (defeats rapid-fire transfers between DIFFERENT machines; duplicates of an
  // already-satisfied move never reach this).
  const minInterval = state.minUpdateIntervalMs ?? DEFAULT_MIN_UPDATE_INTERVAL_MS;
  const last = state.lastPlacementUpdateAt(sessionKey);
  if (last != null && state.now() - last < minInterval) {
    return { action: 'reject', sessionKey, targetMachine: target, rejectReason: 'rate-limited' };
  }

  // Consent gates — ALL applicable conditions are evaluated and STACKED into
  // ONE prompt, so confirming is always informed consent to everything that is
  // actually true (a confirm given for the autonomous-run prompt must never
  // silently consent to an offline target the user was not shown — second-pass
  // finding, 2026-06-13). The WS1.4 autonomous-run condition leads (spec
  // precedence: it fires at transfer-request time, before any move mechanics);
  // `detail` carries every condition, '+'-joined, so callers can see exactly
  // what a confirm consents to.
  const consents: Array<{ detail: string; prompt: string }> = [];
  const run = state.autonomousRunActive?.(sessionKey) ?? null;
  if (run) {
    const remaining = run.remainingMinutes != null ? `, ~${run.remainingMinutes} minutes remaining` : '';
    consents.push({
      detail: 'autonomous-run-in-flight',
      prompt: `There's an autonomous run in flight on this topic${remaining}${run.goal ? ` (goal: ${run.goal})` : ''} — moving will pause it at the next turn boundary and carry its state over.`,
    });
  }
  if (!state.isOnline(target)) {
    consents.push({
      detail: 'target-offline',
      prompt: `${command.nickname} is offline right now — it'll pick up like a fresh-session catch-up once it's back.`,
    });
  }
  if (owner != null && owner !== target && state.isMidReply(sessionKey)) {
    consents.push({
      detail: 'mid-reply',
      prompt: `I'm mid-reply — it'll be like a fresh-session catch-up on the other machine.`,
    });
  }
  if (consents.length > 0) {
    return {
      action: 'confirm-required', sessionKey, targetMachine: target, setPin: true,
      detail: consents.map((c) => c.detail).join('+'),
      confirmationPrompt: `${consents.map((c) => c.prompt).join(' Also: ')} Move to ${command.nickname} anyway?`,
    };
  }

  return { action: 'transfer', sessionKey, targetMachine: target, setPin: true };
}
