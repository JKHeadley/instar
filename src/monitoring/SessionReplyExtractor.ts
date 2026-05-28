/**
 * SessionReplyExtractor — pull the FINAL assistant message out of a completed
 * mentee session's persisted transcript, instead of racing the live tmux pane.
 *
 * The mentor cycle's reply leg (MENTOR-LIVE-READINESS-SPEC §Recipient side)
 * spawns a mentee session and needs its reply. Reading the tmux pane after the
 * session completes is racy (the reaper removes the pane first → empty capture)
 * AND yields raw stream JSON rather than clean prose. The transcript files
 * persist the assistant's final message verbatim:
 *
 *   - Codex: the rollout JSONL carries
 *     `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"…"}}`
 *     (the cleanest source); fallbacks are the last `agent_message` event or the
 *     last `response_item` message with role=assistant.
 *   - Claude Code: the session JSONL carries assistant turns; the last
 *     assistant text block is the reply.
 *
 * Both extractors are pure (string in → string|null out), tolerant of
 * malformed/partial lines, and return null when no assistant text is present
 * (the caller then falls back to the tmux capture).
 */

/** Extract the final assistant message from a Codex rollout JSONL file's content. */
export function extractCodexFinalMessage(content: string): string | null {
  if (!content) return null;
  let lastTaskComplete: string | null = null;
  let lastAgentMessage: string | null = null;
  let lastAssistantItem: string | null = null;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = d['type'];
    const payload = (d['payload'] ?? {}) as Record<string, unknown>;
    const ptype = payload['type'];

    if (type === 'event_msg' && ptype === 'task_complete') {
      const m = payload['last_agent_message'];
      if (typeof m === 'string' && m.trim()) lastTaskComplete = m;
    } else if (type === 'event_msg' && ptype === 'agent_message') {
      const m = payload['message'];
      if (typeof m === 'string' && m.trim()) lastAgentMessage = m;
    } else if (type === 'response_item' && ptype === 'message' && payload['role'] === 'assistant') {
      const content_ = payload['content'];
      if (Array.isArray(content_)) {
        const text = content_
          .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>)['text'] : undefined))
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .join('\n');
        if (text.trim()) lastAssistantItem = text;
      }
    }
  }

  // Preference order: task_complete (the canonical final message) → last
  // agent_message event → last assistant response_item.
  return lastTaskComplete ?? lastAgentMessage ?? lastAssistantItem;
}

/**
 * Extract the final assistant message from a Claude Code session JSONL
 * transcript's content. Claude JSONL rows are one JSON object per line; an
 * assistant turn has `{type:'assistant', message:{content:[{type:'text',text}]}}`
 * (or a string content). Returns the last assistant text block.
 */
export function extractClaudeFinalMessage(content: string): string | null {
  if (!content) return null;
  let last: string | null = null;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Two shapes seen: top-level {type:'assistant', message:{...}} and the
    // message object directly. Normalize.
    const isAssistant =
      d['type'] === 'assistant' ||
      (typeof d['role'] === 'string' && d['role'] === 'assistant');
    if (!isAssistant) continue;
    const msg = (d['message'] ?? d) as Record<string, unknown>;
    const c = msg['content'];
    let text: string | null = null;
    if (typeof c === 'string' && c.trim()) {
      text = c;
    } else if (Array.isArray(c)) {
      const joined = c
        .map((b) => (b && typeof b === 'object' ? (b as Record<string, unknown>)['text'] : undefined))
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .join('\n');
      if (joined.trim()) text = joined;
    }
    if (text) last = text;
  }
  return last;
}
