/**
 * SEC-137: text typed into a session's terminal must never carry bytes that act as keystrokes.
 *
 * A single-line message skips the bracketed-paste wrapper and is typed with `tmux send-keys -l`, so a
 * control byte inside it reaches the terminal as a key press: `\r` submits the tagged part and sends
 * the rest as a separate, untagged turn; `\x15` (Ctrl-U) erases the sender tag already in the input
 * line, so a forged tag can follow; `\x03` or ESC can interrupt the running turn.
 *
 * Chat text has no meaningful use for these bytes, so this is loss-free for real messages:
 * - `\r\n` and a lone `\r` become `\n` (a multi-line message then takes the bracketed-paste path);
 * - every other C0 control except tab and newline, DEL, and every C1 control are removed.
 */
// eslint-disable-next-line no-control-regex
const STRIPPED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function neutralizeTerminalControls(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(STRIPPED, '');
}

/**
 * The full cleaning every typed-text path applies: first the paste-boundary sequences (7-bit and 8-bit
 * spellings, which would otherwise survive as visible `[200~` once ESC is dropped), then the control
 * bytes above. Used by SessionManager.rawInject, the A2A live-session typing path and the pending
 * first-message record, so all three agree on the exact text that reaches the terminal.
 */
export function sanitizeTypedText(text: string): string {
  return neutralizeTerminalControls(text.replace(/(?:\x1b\[|\x9b)20[01]~/g, ''));
}
