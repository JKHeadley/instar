import { detectContextExhaustion } from './QuotaExhaustionDetector.js';

export interface ContextCompactionSessionControl {
  injectInternalControlCommand(sessionName: string, conversationId: string, command: '/compact'): boolean;
  captureOutput(sessionName: string, lines: number): string | null;
}

export interface ContextCompactionAttemptOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  resolveConversationId?: (sessionName: string, topicId: number) => string | null;
}

/**
 * Production composition for SessionRecovery's non-destructive context-wall
 * rung. The triggering topic ID remains authoritative all the way to the
 * action-time control fence; it is never reverse-derived from a tmux name.
 */
export function createContextCompactionAttempt(
  sessionControl: ContextCompactionSessionControl,
  options: ContextCompactionAttemptOptions = {},
): (sessionName: string, topicId: number) => Promise<{ cleared: boolean; reason?: string }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 3_000;
  return async (sessionName, topicId) => {
    const conversationId = options.resolveConversationId
      ? options.resolveConversationId(sessionName, topicId)
      : String(topicId);
    if (!conversationId) return { cleared: false, reason: 'conversation-authority-unavailable' };
    const injected = sessionControl.injectInternalControlCommand(sessionName, conversationId, '/compact');
    if (!injected) return { cleared: false, reason: 'inject-failed' };
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await sleep(pollMs);
      const out = sessionControl.captureOutput(sessionName, 40) || '';
      const tail = out.split('\n').map((line) => line.trim()).filter(Boolean).slice(-12).join('\n');
      if (/error during compaction|compaction failed/i.test(tail)) {
        return { cleared: false, reason: 'compaction-error' };
      }
      if (!detectContextExhaustion(out).matched) return { cleared: true };
    }
    return { cleared: false, reason: 'timeout' };
  };
}
