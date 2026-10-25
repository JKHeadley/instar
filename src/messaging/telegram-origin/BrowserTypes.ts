import { createHash } from 'node:crypto';

export type BrowserJson = null | boolean | number | string | BrowserJson[] | { [key: string]: BrowserJson };
export type BrowserMethod = 'messages.sendMessage' | 'messages.editMessage';
export interface BrowserDestination {
  kind: 'user' | 'chat' | 'channel';
  id: string;
  topicId?: number;
}
/** The outbox owns these bytes and the claim. An HTTP caller cannot mint authority. */
export interface PreparedBrowserChild {
  childId: string;
  originId: string;
  claimFence: string;
  method: BrowserMethod;
  args: { [key: string]: BrowserJson };
  digest: string;
  accountId: string;
  destination: BrowserDestination;
  deadlineMs: number;
  expectedAgentId: string;
  expectedAspTopicId: number;
}
export interface BrowserCanary {
  transport: 'web-k' | 'mtproto';
  buildId: string;
  accountId: string;
  supported: boolean;
}
export interface BrowserReceipt {
  accountId: string;
  destination: BrowserDestination;
  messageId: number;
  randomId?: string;
  state: 'sent' | 'edited' | 'scheduled';
}
export type BrowserOutcome =
  | { state: 'accepted'; receipt: BrowserReceipt }
  | { state: 'known-failed'; reason: string }
  | { state: 'outcome-unknown'; reason: string };
/** Trusted driver, held only by the server's broker; never registered as an MCP tool. */
export interface TelegramBrowserDriver {
  canary(): Promise<BrowserCanary>;
  readSnapshot(): Promise<{ text: string; accountId: string }>;
  resolvePeer?: (destination: BrowserDestination) => Promise<{ [key: string]: BrowserJson }>;
  invoke(child: Readonly<PreparedBrowserChild>): Promise<unknown>;
  /** Must terminate the owning process/connection, including internal retry loops. */
  close(): Promise<void>;
}

/** JCS subset shared with the origin wire contract: no floats, undefined or surrogate loss. */
export function canonicalBrowserJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error('invalid-unicode');
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('invalid-json-array');
    return '[' + value.map(canonicalBrowserJson).join(',') + ']';
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => canonicalBrowserJson(key) + ':' + canonicalBrowserJson((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  throw new Error('invalid-json-value');
}
export function browserOperationDigest(method: BrowserMethod, args: PreparedBrowserChild['args']): string {
  return createHash('sha256').update(canonicalBrowserJson({ method, args })).digest('hex');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function browserPeerMatches(value: unknown, expected: BrowserDestination): boolean {
  const peer = record(value);
  if (!peer) return false;
  const key = expected.kind + '_id';
  return (peer._ === 'peer' + expected.kind[0].toUpperCase() + expected.kind.slice(1)
    || peer._ === 'inputPeer' + expected.kind[0].toUpperCase() + expected.kind.slice(1))
    && String(peer[key]) === expected.id;
}
export function validBrowserMessageId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** No text search, optimistic bubble or unrelated update is an acceptance receipt. */
export function correlateBrowserReceipt(child: PreparedBrowserChild, response: unknown): BrowserReceipt | undefined {
  const result = record(response);
  if (!result) return undefined;
  const sending = child.method === 'messages.sendMessage';
  const randomId = sending ? String(child.args.random_id) : undefined;
  // This constructor is the direct, awaited server result of this exact invocation.
  if (sending && result._ === 'updateShortSentMessage' && validBrowserMessageId(result.id)
    && child.args.schedule_date === undefined) {
    return { accountId: child.accountId, destination: { ...child.destination }, messageId: result.id, randomId, state: 'sent' };
  }
  const updates = Array.isArray(result.updates) ? result.updates.map(record).filter((v): v is Record<string, unknown> => !!v) : [];
  const mapping = sending ? updates.find(u => u._ === 'updateMessageID' && String(u.random_id) === randomId && validBrowserMessageId(u.id)) : undefined;
  const id = sending ? mapping?.id : child.args.id;
  if (!validBrowserMessageId(id)) return undefined;
  const allowed = sending ? ['updateNewMessage', 'updateNewChannelMessage', 'updateNewScheduledMessage'] : ['updateEditMessage', 'updateEditChannelMessage'];
  for (const update of updates) {
    if (!allowed.includes(String(update._))) continue;
    const message = record(update.message);
    if (!message || message.id !== id || !browserPeerMatches(message.peer_id, child.destination) || message.message !== child.args.message) continue;
    const reply = record(message.reply_to);
    if (child.destination.topicId !== undefined && reply?.reply_to_top_id !== child.destination.topicId && reply?.reply_to_msg_id !== child.destination.topicId) continue;
    return { accountId: child.accountId, destination: { ...child.destination }, messageId: id, ...(randomId ? { randomId } : {}), state: !sending ? 'edited' : update._ === 'updateNewScheduledMessage' ? 'scheduled' : 'sent' };
  }
  return undefined;
}
