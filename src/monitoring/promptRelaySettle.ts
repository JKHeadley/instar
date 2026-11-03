/**
 * Settle-before-relay for Prompt Gate.
 *
 * A detected prompt is often answered without a person: the account swap
 * after a usage limit, the permission-prompt floor, a respawn, or the
 * session itself moving on. Relaying it the instant it is seen messages the
 * operator about something that no longer needs them (operator report,
 * 2026-11-02: two prompts relayed at 13:42 were both gone moments later).
 *
 * This waits a short settle window, then looks at the live pane again and
 * relays only if the prompt is still on screen. Signal-only: it never answers
 * a prompt and never blocks one; it only decides whether to send a message.
 * Every uncertainty (pane unreadable, no anchor to look for) fails toward
 * relaying, so a prompt that really needs the operator is never dropped.
 */

import type { DetectedPrompt } from './PromptGate.js';

export const DEFAULT_RELAY_SETTLE_MS = 45_000;
/** Lines of the pane tail a still-pending prompt must appear in. */
const TAIL_LINES = 20;
const MIN_ANCHOR_LEN = 6;

export type SettleVerdict =
  | { relay: true; reason: 'still-pending' | 'pane-unreadable' | 'no-anchor' | 'settle-disabled' }
  | { relay: false; reason: 'session-gone' | 'prompt-cleared' };

export interface SettleDeps {
  settleMs: number;
  sleep: (ms: number) => Promise<void>;
  isAlive: (sessionName: string) => boolean;
  /** Recent pane text, or null when it cannot be read. */
  capture: (sessionName: string) => string | null;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Distinctive text whose presence in the pane tail means the prompt is still up. */
export function promptAnchors(prompt: DetectedPrompt): string[] {
  const labels = (prompt.options ?? [])
    .map((o) => norm(o.label))
    .filter((l) => l.length >= MIN_ANCHOR_LEN);
  if (labels.length > 0) return labels;
  const lines = (prompt.raw ?? '')
    .split('\n')
    .map(norm)
    .filter((l) => l.length >= MIN_ANCHOR_LEN);
  return lines.slice(-2);
}

export async function settleBeforeRelay(prompt: DetectedPrompt, deps: SettleDeps): Promise<SettleVerdict> {
  if (!(deps.settleMs > 0)) return { relay: true, reason: 'settle-disabled' };
  await deps.sleep(deps.settleMs);
  if (!deps.isAlive(prompt.sessionName)) return { relay: false, reason: 'session-gone' };
  const anchors = promptAnchors(prompt);
  if (anchors.length === 0) return { relay: true, reason: 'no-anchor' };
  let pane: string | null;
  try {
    pane = deps.capture(prompt.sessionName);
  } catch {
    pane = null;
  }
  if (pane == null) return { relay: true, reason: 'pane-unreadable' };
  const tail = norm(pane.split('\n').slice(-TAIL_LINES).join('\n'));
  return anchors.some((a) => tail.includes(a))
    ? { relay: true, reason: 'still-pending' }
    : { relay: false, reason: 'prompt-cleared' };
}
