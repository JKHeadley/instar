import { createHash } from 'node:crypto';
import { FailureEpisodeLatch, type FailureEpisodeSnapshot } from '../../core/FailureEpisodeLatch.js';

export interface BrowserRecoveryState {
  fence: string; nextAllowedAt: number; latch: FailureEpisodeSnapshot; failedBuilds: string[];
  attentionId: string | null; attentionAccepted: boolean;
  /** Builds that already raised their one attention item this episode (spec: one item per failed build). */
  signaledBuilds?: string[];
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
      state.attentionId = null; state.attentionAccepted = false; state.signaledBuilds = [];
    } else if (action.kind === 'attention-accepted') state.attentionAccepted = true;
    else {
      const failure = latch.recordFailure();
      if (failure.firstOfEpisode) state.nextAllowedAt = Math.max(state.nextAllowedAt, now + 15 * 60_000);
      if (!state.failedBuilds.includes(action.buildId)) state.failedBuilds = [...state.failedBuilds, action.buildId].slice(-2);
      // One attention item per failed build, raised only after the bounded
      // fresh-process recheck (final) failed. The episode latch still owns the
      // 15-minute floor; a repeat of the same build never raises a second item.
      const signaled = state.signaledBuilds ?? [];
      if (action.final && !signaled.includes(action.buildId)) {
        const build = createHash('sha256').update(action.buildId).digest('hex').slice(0, 16);
        state.attentionId = `browser-canary:${latch.snapshot().failingSince}:${build}`;
        state.attentionAccepted = false;
        state.signaledBuilds = [...signaled, action.buildId].slice(-8);
      }
    }
  }
  state.latch = latch.snapshot();
  return { state, allowed: true };
}
