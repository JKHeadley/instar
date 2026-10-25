/**
 * emergencyStopUserMessage — the ONE source of the text a person is shown
 * after an emergency stop, keyed on what actually HAPPENED.
 *
 * W26 lane 1 (addendum). Both emergency-stop paths — the lifeline route
 * (`POST /internal/telegram-forward` in routes.ts) and the conversational
 * path (TelegramAdapter.processUpdate) — used to branch this text on whether
 * a session NAME resolved, not on whether the kill LANDED. So when a kill
 * failed, the API answered `killed:false` and the log said `KILL FAILED`
 * (both correct) while the operator was told "Session terminated." A stop
 * that lies to the operator is worse than a stop that lies to a log: the
 * person acts on it.
 *
 * Three states, three truths. Plain English only — no session names, no
 * paths, no internal identifiers ever reach this text.
 */
export type EmergencyStopOutcome = 'no-session' | 'killed' | 'kill-failed';

export const EMERGENCY_STOP_USER_MESSAGES: Readonly<Record<EmergencyStopOutcome, string>> = Object.freeze({
  'no-session': 'No active session to stop.',
  'killed': 'Session terminated.\n\nSend a new message to start a fresh session.',
  'kill-failed':
    'Stop failed — the session is still running.\n\n'
    + 'Your stop request was recorded, but the session itself could not be halted. '
    + 'Send stop again, or close the session from the dashboard.',
});

/**
 * Resolve the outcome from the two facts the stop paths actually hold:
 * whether a session was bound to the topic, and whether the kill returned
 * true. An unset/false outcome NEVER reads as success.
 */
export function emergencyStopOutcome(sessionName: string | null | undefined, killed: boolean): EmergencyStopOutcome {
  if (!sessionName) return 'no-session';
  return killed === true ? 'killed' : 'kill-failed';
}

export function emergencyStopUserMessage(sessionName: string | null | undefined, killed: boolean): string {
  return EMERGENCY_STOP_USER_MESSAGES[emergencyStopOutcome(sessionName, killed)];
}
