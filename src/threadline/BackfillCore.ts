/**
 * BackfillCore — pure helpers shared with scripts/threadline-bridge-backfill.mjs.
 *
 * Kept in src/ so they're TypeScript-checked and unit-testable. The
 * script imports the compiled .mjs versions or duplicates the logic
 * inline (the script is a one-shot CLI; it doesn't need a TS build
 * step). This module is the source of truth for the documented
 * contract; the script's own copies must stay in sync.
 */

export const TOPIC_NAME_MAX = 96;
export const MAX_BODY_CHARS = 3800;

export interface BackfillMessage {
  id?: string;
  direction: 'in' | 'out';
  timestamp?: string;
  remoteAgent?: string;
  remoteAgentName?: string;
  text: string;
  outcome?: string;
}

export interface InboxRow {
  id?: string;
  threadId?: string;
  timestamp?: string;
  from?: string;
  senderName?: string;
  text?: string;
}

export interface OutboxRow {
  id?: string;
  threadId?: string;
  timestamp?: string;
  to?: string;
  recipientName?: string;
  text?: string;
  outcome?: string;
}

export interface SeedRow {
  id?: string;
  threadId?: string;
  direction?: 'in' | 'out';
  timestamp?: string;
  remoteAgent?: string;
  remoteAgentName?: string;
  text?: string;
}

/**
 * Build a topic name in the documented `local↔remote — subject` shape,
 * truncating the subject to fit Telegram's 128-char limit (we cap at 96
 * for headroom).
 */
export function buildTopicName(localAgent: string, remoteName: string, subject?: string): string {
  const baseSubject = (subject || 'thread').trim().replace(/\s+/g, ' ');
  const head = `${localAgent}↔${remoteName}`;
  const sep = ' — ';
  const remaining = TOPIC_NAME_MAX - head.length - sep.length;
  const trimmedSubject = remaining > 4 && baseSubject.length > remaining
    ? baseSubject.slice(0, remaining - 1) + '…'
    : baseSubject;
  return `${head}${sep}${trimmedSubject}`.slice(0, TOPIC_NAME_MAX);
}

/** Chunk a body string into Telegram-safe pieces (<= 3800 chars each). */
export function chunkBody(body: string): string[] {
  if (body.length <= MAX_BODY_CHARS) return [body];
  const chunks: string[] = [];
  for (let i = 0; i < body.length; i += MAX_BODY_CHARS) {
    chunks.push(body.slice(i, i + MAX_BODY_CHARS));
  }
  return chunks;
}

/**
 * Combine inbox / outbox / seed rows into a per-thread chronological
 * map. Direction is preserved; missing fields are tolerated. Empty
 * threadIds are dropped.
 */
export function groupByThread(
  inbox: InboxRow[],
  outbox: OutboxRow[],
  seed: SeedRow[] = [],
): Map<string, BackfillMessage[]> {
  const map = new Map<string, BackfillMessage[]>();
  const push = (threadId: string | undefined, msg: BackfillMessage) => {
    if (!threadId) return;
    if (!map.has(threadId)) map.set(threadId, []);
    map.get(threadId)!.push(msg);
  };
  for (const e of inbox) {
    push(e.threadId, {
      id: e.id,
      direction: 'in',
      timestamp: e.timestamp,
      remoteAgent: e.from,
      remoteAgentName: e.senderName || e.from?.slice(0, 8) || '(unknown)',
      text: e.text ?? '',
    });
  }
  for (const e of outbox) {
    push(e.threadId, {
      id: e.id,
      direction: 'out',
      timestamp: e.timestamp,
      remoteAgent: e.to,
      remoteAgentName: e.recipientName || e.to?.slice(0, 8) || '(unknown)',
      text: e.text ?? '',
      outcome: e.outcome,
    });
  }
  for (const e of seed) {
    if (!e.threadId) continue;
    push(e.threadId, {
      id: e.id ?? `seed-${e.timestamp ?? ''}`,
      direction: e.direction === 'out' ? 'out' : 'in',
      timestamp: e.timestamp,
      remoteAgent: e.remoteAgent,
      remoteAgentName: e.remoteAgentName ?? e.remoteAgent?.slice(0, 8) ?? '(unknown)',
      text: e.text ?? '',
    });
  }
  // Sort each thread chronologically.
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  }
  return map;
}

/** Pick the counterparty for a thread: first inbound's sender, else first outbound's recipient. */
export function pickCounterparty(messages: BackfillMessage[]): { id: string; name: string } {
  for (const m of messages) {
    if (m.direction === 'in') {
      return { id: m.remoteAgent ?? '(unknown)', name: m.remoteAgentName ?? '(unknown)' };
    }
  }
  for (const m of messages) {
    if (m.direction === 'out') {
      return { id: m.remoteAgent ?? '(unknown)', name: m.remoteAgentName ?? '(unknown)' };
    }
  }
  return { id: '(unknown)', name: '(unknown)' };
}

/** Stable key for the idempotency ledger. */
export function ledgerKey(m: BackfillMessage): string {
  return m.id || `${m.direction}:${m.timestamp ?? ''}:${m.text.slice(0, 32)}`;
}

/** Compose the per-message body the backfill script posts. */
export function formatBackfillMessage(m: BackfillMessage, localAgentName: string): string {
  const arrow = m.direction === 'in' ? '📥' : '📤';
  const head = m.direction === 'in'
    ? `${arrow} ${m.remoteAgentName ?? '(unknown)'} → ${localAgentName}`
    : `${arrow} ${localAgentName} → ${m.remoteAgentName ?? '(unknown)'}`;
  const meta = m.timestamp ? `\n${m.timestamp}` : '';
  return `${head}${meta}\n${m.text}`;
}
