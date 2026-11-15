/** Plain text for a session reply whose durable delivery record is unresolved.
 * native-conversation-base §3a item 8 (FD-13, FD-15): definite and uncertain are
 * told apart, and no uncertain text ever says the reply "did not reach you". */
export function sessionDeliveryNotice(state: string, uncertain = false): { summary: string; topicText: string } {
  if (uncertain || state === 'outcome-unknown') return {
    summary: 'A reply may have been lost. I cannot confirm whether it reached the conversation, so I will not send a duplicate blindly.',
    topicText: 'An earlier reply may not have reached you. I cannot confirm either way, so I have not sent it twice. If it is missing, tell me and I will send it again.',
  };
  if (state === 'known-failed' || state === 'expired') return {
    summary: 'A reply did not reach the conversation. The original delivery attempt has ended.',
    topicText: 'An earlier reply did not reach you after a delivery interruption.',
  };
  return {
    summary: 'A reply is delayed by a delivery interruption. I am keeping track of the original delivery attempt.',
    topicText: 'A reply I wrote is delayed by a delivery interruption. I am checking the original delivery attempt; it may arrive after newer messages.',
  };
}

/** §3a item 2 — a session reply dispatched more than this long after it was first
 * drafted is late. Inherited from `recoverableLatencyCeiling`; it labels and gates
 * nothing. The 2026-11-25 review (CMT-056) sets it from measured delays. */
export const LATE_REPLY_THRESHOLD_MS = 300_000;

/** "N minutes" up to 90 minutes, "N hours" above. Floors, so "more than N" stays true. */
export function replyAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes > 90) { const hours = Math.floor(minutes / 60); return `${hours} ${hours === 1 ? 'hour' : 'hours'}`; }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** §3a item 2 — the late reply's own first line, or null under the threshold.
 * N is the age when the line is sealed; "more than" keeps it true however much
 * longer delivery then takes. */
export function lateRecoveredReplyNotice(firstPreparedAt: number, now: number): string | null {
  if (!Number.isFinite(firstPreparedAt) || !Number.isFinite(now) || now - firstPreparedAt <= LATE_REPLY_THRESHOLD_MS) return null;
  return `Late reply, written more than ${replyAge(now - firstPreparedAt)} ago and held up in delivery. It answers an earlier message:`;
}

/** §3a item 5 — the author is told its reply went out late, and what the user saw. */
export function lateDeliverySessionLine(input: { operationId: string; deliveredAfterMs: number; marked: boolean }): string {
  const head = `Your reply \`${input.operationId}\` was delivered ${replyAge(input.deliveredAfterMs)} after you wrote it.`;
  return input.marked
    ? `${head} It carries a first line telling the user it is late. Follow up here if it is no longer right.`
    : `${head} No late notice could be added, so the user has no sign that it is late. Follow up here if it is no longer right.`;
}

/** One line per recovery pass, every id, grouped marked first, then not marked. */
export function lateDeliverySessionBatch(entries: ReadonlyArray<{ operationId: string; deliveredAfterMs: number; marked: boolean }>): string | null {
  if (!entries.length) return null;
  const ordered = [...entries.filter(e => e.marked), ...entries.filter(e => !e.marked)];
  return ordered.map(lateDeliverySessionLine).join(' ');
}

export type DefiniteFailureCause = 'refused' | 'never-left' | 'deadline';
/** §3a item 8 — three fixed phrases, chosen from the classified `failure`. */
export function failureCausePhrase(cause: DefiniteFailureCause): string {
  return cause === 'refused' ? 'Telegram refused it'
    : cause === 'never-left' ? 'it could not be sent before its attempts ran out'
    : 'it passed its delivery deadline';
}

/** §3a item 8 — the session line for a reply that definitely did not arrive. */
export function definiteSessionLine(input: { operationId: string; ageMs: number; cause: DefiniteFailureCause }): string {
  return `Your reply \`${input.operationId}\`, written ${replyAge(input.ageMs)} ago, was not delivered (${failureCausePhrase(input.cause)}) and will not be retried. ` +
    `Its text is at \`GET /telegram/origins/operations/${input.operationId}/text\`. Send it again if it is still needed.`;
}

/** §3a item 8 — the session line for a reply whose delivery could not be confirmed. */
export function uncertainSessionLine(input: { operationId: string; ageMs: number }): string {
  return `Delivery of your reply \`${input.operationId}\`, written ${replyAge(input.ageMs)} ago, could not be confirmed. It may have arrived. ` +
    'Do not send it again unless the user says it is missing.';
}

/** §3a item 7 — an older owner ended the reply and gave no reason (settled). */
export function ownerUnstatedSessionLine(operationId: string): string {
  return `Reply \`${operationId}\` was ended by the machine that sends to Telegram, which runs an older version and gave no reason. ` +
    'The user may already have this text. Check the conversation before repeating it.';
}

/** MarkdownV2 reserves these characters; the late line must be escaped to stay valid there. */
export function lateLineForParseMode(line: string, parseMode: unknown): string {
  return parseMode === 'MarkdownV2' ? line.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, ch => `\\${ch}`) : line;
}
