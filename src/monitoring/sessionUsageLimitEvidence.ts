/** Exact-session corroboration for standby usage-limit notices. Pane text is
 * only a signal: tools and helpers can print the same banner. Only the latest
 * main assistant turn's provider-owned API error can establish this claim. */
import { readJsonlTailLines } from '../utils/jsonl-tail.js';

export function confirmSessionUsageLimit(transcriptPath: string, sessionId: string): boolean {
  if (!transcriptPath || !sessionId) return false;
  const { lines } = readJsonlTailLines(transcriptPath, 128 * 1024);
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try { row = JSON.parse(lines[i]); }
    catch { return false; /* partial/corrupt latest record is unknown */ }
    if (row.sessionId !== sessionId || row.isSidechain || row.agentId) continue;
    if (row.type !== 'assistant' && row.type !== 'user') continue;
    // User/tool-result rows or a later normal assistant turn refute an old
    // error. Nested tool_result text is never inspected for an API signature.
    return row.type === 'assistant' && row.isApiErrorMessage === true
      && (row.error === 'rate_limit' || row.error === 'rate_limit_error');
  }
  return false;
}
