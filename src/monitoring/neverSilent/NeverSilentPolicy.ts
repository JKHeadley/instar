/**
 * Never-Silent Conversation — the deterministic class → action table (§3.3) and the
 * fixed notice templates (§3.4, Frontloaded Decision 4). Pure: no I/O.
 *
 * The judge decides the class; this table decides what may be done about it, and the
 * floors live here: confidence floor, truncated input caps at tell, per-action
 * switches, the replay boundary (an unknown or effectful history never moves a
 * conversation automatically), pinned conversations are asked (Decision 2), and the
 * breaker (never move back to an engine already tried in this incident).
 */
import type { SilenceClass } from './NeverSilentStore.js';
import type { ActionsSinceMessage } from './ConversationSilenceJudge.js';
import { FRAMEWORK_DISPLAY_NAMES } from '../../core/frameworkFacts.js';

export type NeverSilentAction =
  | 'wait'            // working-slow: no action, obligation stays open
  | 'tell'            // notice only
  | 'swap'            // another signed-in account on the same engine
  | 'fallback'        // move the conversation to another engine (unpinned)
  | 'ask-fallback';   // pinned (or unsafe replay): ask with one tap

export interface PolicyInput {
  silenceClass: SilenceClass;
  confidence: number;
  truncated: boolean;
  actionsSinceMessage: ActionsSinceMessage;
  /** The operator chose this conversation's engine (a non-system topic-profile pin). */
  pinned: boolean;
  /** Actions master switch for this class (off until measured, §3.7). */
  actionsEnabled: boolean;
  frameworkFallbackEnabled: boolean;
  confidenceFloor: number;
  /** Another signed-in account exists on the stuck engine. */
  sameEngineHealthy: boolean;
  /** An engine other than the stuck one, not yet tried in this incident, has a signed-in account. */
  fallbackEngine: string | null;
  /** A same-engine swap was already attempted in this incident. */
  swapTried: boolean;
  /** A protected session is never moved or swapped (§3.3 brakes). */
  protectedSession: boolean;
  /** The conversation was moved back after a repair recently: a new silence asks instead of moving (the repair did not hold). */
  recentlyRestored: boolean;
  /**
   * Spec stale-process-login-expired D2: the fresh-login probe's disposition for this session's
   * stored login, whether an in-place refresh is in progress or still possible for this session,
   * and whether this incident's 3-minute hold-off has run out. All optional (absent ⇒ today).
   */
  loginProbe?: 'ok' | 'refused' | 'pending' | 'inconclusive';
  inPlaceRefreshPossible?: boolean;
  staleHoldExpired?: boolean;
}

/** Spec stale-process-login-expired D2: NeverSilent holds off at most this long per incident. */
export const STALE_LOGIN_HOLD_MS = 3 * 60_000;
export const STALE_LOGIN_WAIT_REASON = 'stale-login: restarting on its own sign-in';

export interface PolicyDecision { action: NeverSilentAction; reason: string; target?: string }

const RECOVERABLE: ReadonlySet<SilenceClass> = new Set(['engine-login', 'usage-or-subscription-wall']);

export function decideNeverSilentAction(i: PolicyInput): PolicyDecision {
  if (i.silenceClass === 'working-slow') return { action: 'wait', reason: 'still working' };
  // A session stuck on an expired screen while its stored login works is being restarted on its own
  // sign-in: no swap or engine move while that check or restart is under way, and never past the
  // incident's 3-minute hold-off.
  if (i.silenceClass === 'engine-login' && !i.staleHoldExpired
    && (i.loginProbe === 'pending' || (i.loginProbe === 'ok' && i.inPlaceRefreshPossible === true))) {
    return { action: 'wait', reason: STALE_LOGIN_WAIT_REASON };
  }
  if (!RECOVERABLE.has(i.silenceClass)) return { action: 'tell', reason: `class ${i.silenceClass} has no automatic action` };
  if (!i.actionsEnabled) return { action: 'tell', reason: 'actions not enabled' };
  if (i.protectedSession) return { action: 'tell', reason: 'protected session' };
  if (i.truncated) return { action: 'tell', reason: 'judged on cut screen text' };
  if (!(i.confidence >= i.confidenceFloor)) return { action: 'tell', reason: `confidence ${i.confidence} below floor ${i.confidenceFloor}` };
  const replaySafe = i.actionsSinceMessage === 'none' || i.actionsSinceMessage === 'read-only';
  if (i.sameEngineHealthy && !i.swapTried) {
    return replaySafe ? { action: 'swap', reason: 'another signed-in account on this engine' } : { action: 'tell', reason: `actions since message: ${i.actionsSinceMessage}` };
  }
  if (!i.fallbackEngine || !i.frameworkFallbackEnabled) {
    return { action: 'tell', reason: i.fallbackEngine ? 'engine fallback not enabled' : 'no other engine has a signed-in account' };
  }
  if (i.pinned) return { action: 'ask-fallback', reason: 'engine chosen by the operator', target: i.fallbackEngine };
  if (i.recentlyRestored) return { action: 'ask-fallback', reason: 'moved back after a repair that did not hold', target: i.fallbackEngine };
  if (!replaySafe) return { action: 'ask-fallback', reason: `actions since message: ${i.actionsSinceMessage}`, target: i.fallbackEngine };
  return { action: 'fallback', reason: 'no signed-in account on this engine', target: i.fallbackEngine };
}

// ── Notices (fixed templates; the judge's evidence is never shown) ────────────

export function engineName(fw: string | null | undefined): string {
  return (fw && (FRAMEWORK_DISPLAY_NAMES as Record<string, string>)[fw]) || 'the AI engine';
}

function lead(count: number): string {
  return count > 1 ? `Your last ${count} messages weren't answered` : "Your message wasn't answered";
}

function cause(cls: SilenceClass, fw: string | null): string {
  switch (cls) {
    case 'engine-login': return `the ${engineName(fw)} sign-in this conversation uses ran out`;
    case 'usage-or-subscription-wall': return `the ${engineName(fw)} account this conversation uses hit its usage limit`;
    case 'startup-dialog': return 'the session stopped at a question when it started';
    case 'crashed': return 'the session stopped running';
    case 'message-not-delivered': return "your message didn't reach the session";
    case 'waiting-for-machine': return "it's waiting for the other machine that runs this conversation, which can't take messages yet";
    default: return "I couldn't tell why yet";
  }
}

export interface NoticeInput {
  kind: 'waiting' | 'status';
  count: number;
  silenceClass: SilenceClass | null;
  framework: string | null;
  action: NeverSilentAction | null;
  outcome: 'started' | 'succeeded' | 'refused' | 'exhausted' | null;
  target?: string | null;
  repairStarted?: boolean;
  /** Why a one-tap ask was used instead of moving automatically. */
  askReason?: 'pinned' | 'replay';
  /** A waiting notice for a session being restarted on its own sign-in (spec stale-process-login-expired). */
  waitingReason?: 'restarting-sign-in';
}

export function renderNotice(n: NoticeInput): string {
  if (n.kind === 'waiting' && n.waitingReason === 'restarting-sign-in') {
    return `${lead(n.count)} yet. The session got stuck on an old sign-in, so I'm restarting it on its own sign-in, which still works. I'll tell you here if that doesn't fix it.`;
  }
  if (n.kind === 'waiting' && n.silenceClass === 'working-slow') {
    return `${lead(n.count)} yet. It's still being worked on; I'll tell you here if anything goes wrong.`;
  }
  if (n.kind === 'waiting' || !n.silenceClass || n.silenceClass === 'undetermined' || n.silenceClass === 'other') {
    return `${lead(n.count)} yet. I couldn't tell why, so I'm still looking into it and will tell you here when it's answered.`;
  }
  const head = `${lead(n.count)}: ${cause(n.silenceClass, n.framework)}.`;
  const repair = n.repairStarted ? ` I've started the ${engineName(n.framework)} sign-in repair.` : '';
  switch (n.action) {
    case 'swap':
      if (n.outcome === 'succeeded') return `${head} I've switched it to another signed-in account so it can answer now.`;
      return `${head} I tried switching to another account, but that didn't work.${repair} I'll tell you here when it's fixed.`;
    case 'fallback':
      if (n.outcome === 'succeeded' || n.outcome === 'started') {
        return `${head} I've moved this conversation to ${engineName(n.target)} so it can answer now.${repair} It goes back to ${engineName(n.framework)} at its next restart once the sign-in works again.`;
      }
      return `${head} I couldn't move it to ${engineName(n.target)}.${repair} I'll tell you here when it's fixed.`;
    case 'ask-fallback':
      return `${head} ${n.askReason === 'replay' ? 'It had already started acting on your message' : `You set this conversation to ${engineName(n.framework)}`}, so I haven't moved it. Tap below to move it to ${engineName(n.target)} and get an answer now.${repair} Otherwise it stays on ${engineName(n.framework)} and I'll tell you here when it's fixed.`;
    default:
      return `${head}${repair} I'll tell you here when it's answered or fixed.`;
  }
}

export const ASK_BUTTON_TEXT = (target: string | null | undefined): string => `Move to ${engineName(target)}`;
