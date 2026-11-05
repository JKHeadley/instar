/**
 * Whether a setup session that isn't running should be started again
 * (docs/specs/recommended-services.md, The agent owns setup). A pure decision, so its bound can be
 * proven under sustained pressure in the self-action ratchet. A session that ran a long while
 * probably waited on the person and was idled out, which isn't a failure: it stays down until they
 * reply. A session that dies quickly gets a limited number of starts, with growing waits, then one
 * notice.
 */
export const MAX_SETUP_STARTS = 3;
export const SETUP_RETRY_MS = 5 * 60_000;
export const SETUP_LONG_RUN_MS = 60 * 60_000;

export type SetupRestartDecision = 'wait' | 'restart' | 'give-up' | 'dormant';

export function decideSetupRestart(input: { starts: number; lastStartMs: number | null; nowMs: number }): SetupRestartDecision {
  const { starts, lastStartMs, nowMs } = input;
  if (lastStartMs === null) return 'restart';
  const since = nowMs - lastStartMs;
  if (since >= SETUP_LONG_RUN_MS) return 'dormant';
  if (starts >= MAX_SETUP_STARTS) return 'give-up';
  return since >= SETUP_RETRY_MS * 2 ** Math.max(0, starts - 1) ? 'restart' : 'wait';
}
