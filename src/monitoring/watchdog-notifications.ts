/**
 * Decide whether and how to surface a watchdog intervention to the user.
 *
 * Principle: routine auto-recovery (Ctrl+C, SIGTERM) is internal diagnostics.
 * The user only hears about it when the gentle path fails and we had to
 * force-kill — that is the "actual issue" boundary. Messages that do go out
 * are in plain English, no jargon, no raw commands.
 */
import { EscalationLevel, type InterventionEvent } from './SessionWatchdog.js';

/**
 * Returns the user-facing message for an intervention, or `null` when the
 * intervention is routine and should not be surfaced to the user.
 */
export function formatWatchdogUserMessage(event: InterventionEvent): string | null {
  // Interrupting a test run is NOT routine, however gently it is done: a
  // Ctrl+C throws away everything the run had completed, and the harness that
  // launched it can still report a clean exit — so the person who asked for
  // the run would never learn it had been cut short (2026-10-20: a full suite
  // was interrupted at 61 minutes and reported as finished). Announced once
  // per episode; a later force-kill still adds its own line below.
  if (event.stuckCommandKind && (event.stuckRetryCount ?? 0) === 0
      && event.level === EscalationLevel.CtrlC) {
    const minutes = Math.max(1, Math.round((event.stuckElapsedMs ?? 0) / 60_000));
    const what = event.stuckCommandKind === 'test-runner-ancestor'
      ? 'a command that was running tests'
      : 'a test run';
    return `I stopped ${what} that had been going for ${minutes} minutes, because it looked stuck. `
      + 'Nothing it had finished is kept, so it needs to run again — '
      + "if it was healthy, tell me and I'll give that kind of run more room.";
  }
  if (event.level === EscalationLevel.SigKill) {
    return "A task I was running got stuck and wouldn't stop on its own. I had to force it to close. I'm picking back up now.";
  }
  if (event.level === EscalationLevel.KillSession) {
    return "A session of mine got stuck and wouldn't respond. I had to close it and start a fresh one. I'll pick back up from where I was.";
  }
  // Monitoring, Ctrl+C, SIGTERM — routine, silent to the user.
  return null;
}
