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
  if (event.level === EscalationLevel.SigKill) {
    return "A task I was running got stuck and wouldn't stop on its own. I had to force it to close. I'm picking back up now.";
  }
  if (event.level === EscalationLevel.KillSession) {
    return "A session of mine got stuck and wouldn't respond. I had to close it and start a fresh one. I'll pick back up from where I was.";
  }
  // Monitoring, Ctrl+C, SIGTERM — routine, silent to the user.
  return null;
}

/**
 * The line told to the SESSION whose command the watchdog interrupted. The
 * session's own tool call sees a foreground command fail, but a background
 * command (a `run_in_background` shell, a Monitor watch, a poll loop) just
 * stops, and the session goes on believing it is still running. One notice per
 * interrupted process, on the first signal only (later escalation steps on the
 * same process add nothing the session can act on). Never for a session-level
 * kill: there is no session left to tell.
 */
export function formatWatchdogSessionNotice(event: InterventionEvent): string | null {
  if (event.level !== EscalationLevel.CtrlC || event.effectScope !== 'target-process') return null;
  if (event.action.startsWith('Retry')) return null;
  const command = event.stuckCommand.replace(/\s+/g, ' ').trim().slice(0, 120); // bounded-input-reviewed: an identifying echo of the command; the pid and the record path that follow carry what the session acts on
  return `[instar watchdog] I stopped a command in this session that looked stuck: \`${command}\` (pid ${event.stuckPid}). ` +
    'If it was a deliberate wait (a poll loop, a Monitor watch, a background sleep), it is no longer running: start it again if you still need it, ' +
    'and do not report it as running. Record: .instar/watchdog-interventions.jsonl';
}
