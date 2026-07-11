export const TELEGRAM_TEXT_LIMIT = 4096;
export const MENTOR_ECHO_MAX_CHUNKS = 3;
export const MENTOR_ECHO_SHORTENED = '…shortened for chat; full prompt was delivered';

export interface VisibleEchoChunkPlan {
  messages: string[];
  bodyChunks: string[];
  shortened: boolean;
}

function takeChunk(text: string, capacity: number): [string, string] {
  if (text.length <= capacity) return [text, ''];
  const window = text.slice(0, capacity);
  const newline = window.lastIndexOf('\n');
  const cut = newline > 0 ? newline + 1 : capacity;
  return [text.slice(0, cut), text.slice(cut)];
}

/** Pure Telegram-safe planner. Prefix/part markers are included in the limit. */
export function planMentorVisibleEcho(
  body: string,
  roleTag = '[mentor]',
  maxChunks = MENTOR_ECHO_MAX_CHUNKS,
): VisibleEchoChunkPlan {
  for (let total = 1; total <= maxChunks; total += 1) {
    let rest = body;
    const bodyChunks: string[] = [];
    for (let i = 1; i <= total; i += 1) {
      const prefix = `${roleTag} (${i}/${total})\n`;
      const [chunk, next] = takeChunk(rest, TELEGRAM_TEXT_LIMIT - prefix.length);
      bodyChunks.push(chunk);
      rest = next;
    }
    if (!rest) {
      return {
        bodyChunks,
        messages: bodyChunks.map((chunk, i) => `${roleTag} (${i + 1}/${total})\n${chunk}`),
        shortened: false,
      };
    }
  }

  let rest = body;
  const bodyChunks: string[] = [];
  for (let i = 1; i <= maxChunks; i += 1) {
    const prefix = `${roleTag} (${i}/${maxChunks})\n`;
    const tail = i === maxChunks ? `\n\n${MENTOR_ECHO_SHORTENED}` : '';
    const [chunk, next] = takeChunk(rest, TELEGRAM_TEXT_LIMIT - prefix.length - tail.length);
    bodyChunks.push(chunk);
    rest = next;
  }
  return {
    bodyChunks,
    messages: bodyChunks.map((chunk, i) => {
      const tail = i === maxChunks - 1 ? `\n\n${MENTOR_ECHO_SHORTENED}` : '';
      return `${roleTag} (${i + 1}/${maxChunks})\n${chunk}${tail}`;
    }),
    shortened: true,
  };
}

export interface MentorVisibleEchoOptions {
  enabled: boolean;
  bot?: { sendToTopic: (topicId: number, text: string) => Promise<unknown> };
  topicId?: number;
  roleTag: string;
  log?: (line: string) => void;
  reportFailure?: (reason: string) => void;
}

export async function sendMentorVisibleEcho(body: string, opts: MentorVisibleEchoOptions): Promise<void> {
  const log = opts.log ?? console.log;
  if (!opts.enabled) {
    log('[mentor-echo] skipped outcome=disabled');
    return;
  }
  if (!opts.bot || opts.topicId === undefined) {
    log('[mentor-echo] skipped outcome=unconfigured');
    return;
  }
  const plan = planMentorVisibleEcho(body, opts.roleTag);
  let landed = 0;
  for (let i = 0; i < plan.messages.length; i += 1) {
    try {
      await opts.bot.sendToTopic(opts.topicId, plan.messages[i]);
      landed += 1;
    } catch (err) {
      const reason = `chunk ${i + 1}/${plan.messages.length} failed after ${landed} landed: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[mentor-echo] outcome=partial topic=${opts.topicId} ${reason}`);
      try { opts.reportFailure?.(reason); } catch { /* @silent-fallback-ok: degradation reporting must never affect canonical delivery */ }
      return;
    }
  }
  log(`[mentor-echo] outcome=visible topic=${opts.topicId} chunks=${landed} shortened=${plan.shortened}`);
}
