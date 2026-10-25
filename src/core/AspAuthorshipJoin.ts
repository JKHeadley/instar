import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { splitTag } from './agentSignatureProvenance.js';
import type { AspClassificationRecord } from './AspInboundClassifier.js';

export const ASP_CLASSIFICATION_START = Date.parse('2026-08-19T00:00:00.000Z');

export type MessageAuthorship =
  | 'agent-outbound'
  | 'agent-verified'
  | 'human'
  | 'rejected'
  | 'UNRESOLVED'
  | 'unclassifiable';

export interface AuthorshipMessage {
  messageId: number;
  topicId: number | null;
  text: string;
  fromUser: boolean;
  timestamp: string;
}

/** Joins the durable ASP verdict authority onto the durable Telegram re-read row. */
export class AspAuthorshipJoin {
  private cachedStamp = '';
  private cachedVerdicts = new Map<string, AspClassificationRecord>();

  constructor(
    private readonly ledgerPath: string,
    private readonly classificationStartMs = ASP_CLASSIFICATION_START,
  ) {}

  join<T extends AuthorshipMessage>(
    messages: readonly T[],
  ): Array<T & { authorship: MessageAuthorship; authorshipAgentId: string | null }> {
    const verdicts = this.readVerdicts();
    return messages.map((message) => {
      const authorship = this.resolve(message, verdicts);
      // The agent id rides ONLY a verified verdict — a rejected or unresolved row
      // must not name an agent it could not prove.
      const authorshipAgentId = authorship === 'agent-verified'
        ? verdicts.get(key(message.topicId, message.messageId))?.agentId ?? null
        : null;
      return { ...message, authorship, authorshipAgentId };
    });
  }

  private resolve(message: AuthorshipMessage, verdicts: Map<string, AspClassificationRecord>): MessageAuthorship {
    if (!message.fromUser) return 'agent-outbound';
    const at = Date.parse(message.timestamp);
    if (!Number.isFinite(at) || at < this.classificationStartMs) return 'unclassifiable';

    const verdict = verdicts.get(key(message.topicId, message.messageId));
    if (!verdict) return 'UNRESOLVED';

    // Message ids are the primary join key; the body hash is the anti-misjoin control.
    // A stale/corrupt ledger row must fail visibly rather than attribute different bytes.
    const body = splitTag(message.text).body;
    if (verdict.bodyHash !== createHash('sha256').update(body, 'utf8').digest('hex')) return 'UNRESOLVED';
    return verdict.classification;
  }

  private readVerdicts(): Map<string, AspClassificationRecord> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.ledgerPath);
    } catch {
      this.cachedStamp = 'missing';
      this.cachedVerdicts = new Map();
      return this.cachedVerdicts;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (stamp === this.cachedStamp) return this.cachedVerdicts;

    const result = new Map<string, AspClassificationRecord>();
    for (const line of fs.readFileSync(this.ledgerPath, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as AspClassificationRecord;
        if (typeof row.messageId !== 'number' || (typeof row.topicId !== 'number' && row.topicId !== null)) continue;
        if (!['agent-verified', 'human', 'rejected'].includes(row.classification)) continue;
        result.set(key(row.topicId, row.messageId), row);
      } catch { /* malformed evidence cannot silently become authorship */ }
    }
    this.cachedStamp = stamp;
    this.cachedVerdicts = result;
    return this.cachedVerdicts;
  }
}

function key(topicId: number | null, messageId: number): string {
  return `${topicId ?? 'root'}:${messageId}`;
}
