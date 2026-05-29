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
  /** When the topic last had a placement update (for the rate limit), or null. */
  lastPlacementUpdateAt: (sessionKey: string) => number | null;
  now: () => number;
  /** Minimum ms between placement updates per topic. Default 10000. */
  minUpdateIntervalMs?: number;
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

  // Rate limit — at most one placement update per topic per interval (defeats rapid-fire transfers).
  const minInterval = state.minUpdateIntervalMs ?? DEFAULT_MIN_UPDATE_INTERVAL_MS;
  const last = state.lastPlacementUpdateAt(sessionKey);
  if (last != null && state.now() - last < minInterval) {
    return { action: 'reject', sessionKey, targetMachine: target, rejectReason: 'rate-limited' };
  }

  const owner = state.currentOwnerOf(sessionKey);

  // Already on the target → no transfer needed (still applies the pin if requested).
  if (owner === target) {
    return { action: 'noop', sessionKey, targetMachine: target, setPin: true, detail: 'already-on-target' };
  }

  // Confirmation gate (§L4): offline target, OR a different owner while mid-reply.
  if (!state.isOnline(target)) {
    return {
      action: 'confirm-required', sessionKey, targetMachine: target, setPin: true,
      confirmationPrompt: `${command.nickname} is offline right now. Move this conversation there anyway? It'll pick up like a fresh-session catch-up once it's back.`,
    };
  }
  if (owner != null && owner !== target && state.isMidReply(sessionKey)) {
    return {
      action: 'confirm-required', sessionKey, targetMachine: target, setPin: true,
      confirmationPrompt: `Move this to ${command.nickname}? I'm mid-reply — it'll be like a fresh-session catch-up on the other machine.`,
    };
  }

  return { action: 'transfer', sessionKey, targetMachine: target, setPin: true };
}
