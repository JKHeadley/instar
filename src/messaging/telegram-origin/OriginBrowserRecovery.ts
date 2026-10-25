import { FailureEpisodeLatch, type FailureEpisodeSnapshot } from '../../core/FailureEpisodeLatch.js';

export interface BrowserRecoveryState {
  fence: string; nextAllowedAt: number; latch: FailureEpisodeSnapshot; failedBuilds: string[];
  attentionId: string | null; attentionAccepted: boolean;
}
export type BrowserRecoveryAction = { kind: 'begin'; fence: string } | { kind: 'success'; fence: string }
  | { kind: 'failure'; fence: string; buildId: string; final: boolean } | { kind: 'attention-accepted'; fence: string };
export interface BrowserRecoveryDecision { state: BrowserRecoveryState; allowed: boolean; }
/** Existing episode latch plus a persisted 15-minute process-start floor.
 * The caller's outbox owns the finite send budget; this grants no message send. */
export function advanceBrowserRecovery(previous: BrowserRecoveryState | null, action: BrowserRecoveryAction, now: number): BrowserRecoveryDecision {
  const latch = new FailureEpisodeLatch({ signalAfterMs: action.kind === 'failure' && action.final ? 0 : Number.MAX_SAFE_INTEGER, now: () => now });
  if (previous) latch.restore(previous.latch);
  const state: BrowserRecoveryState = previous ? structuredClone(previous) : { fence: '', nextAllowedAt: 0,
    latch: latch.snapshot(), failedBuilds: [], attentionId: null, attentionAccepted: false };
  if (action.kind === 'begin') {
    if (state.nextAllowedAt > now) return { state, allowed: false };
    state.fence = action.fence; state.nextAllowedAt = now + 15 * 60_000;
  } else {
    if (state.fence !== action.fence) return { state, allowed: false };
    if (action.kind === 'success') {
      latch.recordSuccess(); state.nextAllowedAt = 0; state.failedBuilds = [];
      state.attentionId = null; state.attentionAccepted = false;
    } else if (action.kind === 'attention-accepted') state.attentionAccepted = true;
    else {
      const failure = latch.recordFailure();
      if (failure.firstOfEpisode) state.nextAllowedAt = Math.max(state.nextAllowedAt, now + 15 * 60_000);
      if (!state.failedBuilds.includes(action.buildId)) state.failedBuilds = [...state.failedBuilds, action.buildId].slice(-2);
      if (failure.shouldSignal) state.attentionId = `browser-canary:${latch.snapshot().failingSince}`;
    }
  }
  state.latch = latch.snapshot();
  return { state, allowed: true };
}
