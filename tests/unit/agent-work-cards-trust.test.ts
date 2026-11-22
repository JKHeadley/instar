/**
 * agent-work-cards-default §5 (the trust-request queue): an undelivered agent-raised request does not count toward
 * the open cap and has its own cap; the acceptance flush is bounded; a withdrawn request refuses its code, cannot be
 * re-raised until it would have expired, and a board-policy request is never withdrawable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountPathService, MAX_OPEN_REQUESTS, type DirectChatPort } from '../../src/core/trustJourney/AccountPathService.js';
import { LocalFileTrustSink, TrustJourneyStore, type TrustChange } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { acceptanceStatement, type Receipt } from '../../src/core/trustJourney/accountPath.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OWNER = '777';
class FakeChat implements DirectChatPort {
  sent: Array<{ to: string; text: string; messageId: string }> = [];
  replies: Array<{ messageId: string; text: string }> = [];
  private n = 100;
  async sendDirect(to: string, text: string) { const messageId = String(this.n++); this.sent.push({ to, text, messageId }); return { chatId: to, messageId }; }
  async replyTo(_chat: string, messageId: string, text: string) { this.replies.push({ messageId, text }); return true; }
}
let dir: string; let chat: FakeChat; let store: TrustJourneyStore; let svc: AccountPathService; let updateId = 1;
const receipt = (text: string, over: Partial<Receipt> = {}): Receipt => {
  const id = updateId++;
  return { receiptId: `rc${id}`, adapter: 'telegram', senderId: OWNER, chatId: OWNER, chatType: 'private', messageId: String(9000 + id), text, senderIsBot: false, forwarded: false, uniqueKey: `tg:${id}`, receivedAt: new Date().toISOString(), receivedBy: 'm1', ...over };
};
const grant = (level: string): TrustChange => ({ kind: 'trust-grant', service: 'github', operation: 'write', level } as TrustChange);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awc-trust-'));
  chat = new FakeChat();
  store = new TrustJourneyStore(new LocalFileTrustSink(path.join(dir, 'trust-journey.jsonl')));
  svc = new AccountPathService({
    store, adapters: { telegram: chat }, ownerPlatformId: (a) => (a === 'telegram' ? OWNER : null), installationId: 'inst-1',
    raisesOf: (c) => ((c as { kind: string }).kind === 'board-policy' ? ['work board policy outward-only'] : [`${(c as { level?: string }).level ?? 'x'}`]),
    summarize: (c) => [`change ${JSON.stringify(c)}`], apply: async () => ({ ok: true }), cardTtlDays: () => 7,
  });
});
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/agent-work-cards-trust.test.ts' }); });

describe('the undelivered cap and the bounded flush', () => {
  it('before acceptance, undelivered requests have their own cap; on acceptance the flush sends min(cap − delivered, undelivered), newest first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_OPEN_REQUESTS; i++) { const r = await svc.propose(grant(`level-${i}`)); expect(r.status).toBe('awaiting-acceptance'); ids.push((r as { requestId: string }).requestId); }
    const over = await svc.propose(grant('level-over'));
    expect(over.status).toBe('too-many-undelivered');
    // none of them counts toward the open cap of DELIVERED requests
    expect(store.openRequests().filter((r) => r.cardMessageId).length).toBe(0);
    const sentBefore = chat.sent.length;
    await svc.onReceipt(receipt(acceptanceStatement({ adapter: 'telegram', accountId: OWNER, installationId: 'inst-1' })));
    expect(chat.sent.length - sentBefore).toBe(MAX_OPEN_REQUESTS); // the flush: exactly cap − 0 delivered
    expect(store.openRequests().filter((r) => r.cardMessageId).length).toBe(MAX_OPEN_REQUESTS);
    // now the delivered cap is full
    const r2 = await svc.propose(grant('level-after'));
    expect(r2.status).toBe('too-many-open');
  });
});

describe('withdraw', () => {
  it('withdraws an unanswered agent-raised request, tells its card, refuses the code, and refuses the same change until it would have expired; unknown, consumed and board-policy requests are refused', async () => {
    await svc.onReceipt(receipt(acceptanceStatement({ adapter: 'telegram', accountId: OWNER, installationId: 'inst-1' })));
    const r = await svc.propose(grant('autonomous')); expect(r.status).toBe('sent');
    const id = (r as { requestId: string; code: string }).requestId; const code = (r as { code: string }).code;
    const card = chat.sent.at(-1)!;
    const w = await svc.withdraw(id);
    expect(w).toMatchObject({ ok: true, status: 'withdrawn', cardTold: true });
    expect(chat.replies.at(-1)).toMatchObject({ messageId: card.messageId });
    expect(store.request(id)!.status).toBe('withdrawn');
    // the code approves nothing now
    const reply = await svc.onReceipt(receipt(`approve ${code}`, { replyToMessageId: card.messageId }));
    expect(reply).not.toBe('approved');
    expect(await svc.withdraw(id)).toMatchObject({ ok: false, reason: 'not-open' });
    expect(await svc.withdraw('tr-000000000000-NOPE')).toMatchObject({ ok: false, reason: 'not-found' });
    const again = await svc.propose(grant('autonomous'));
    expect(again.status).toBe('withdrawn-recently');
    const other = await svc.propose(grant('log'));
    expect(other.status).toBe('sent');
    const bp = await svc.propose({ kind: 'board-policy', policy: 'outward-only' } as TrustChange);
    expect(bp.status).toBe('sent');
    expect(await svc.withdraw((bp as { requestId: string }).requestId)).toMatchObject({ ok: false, reason: 'board-policy-not-withdrawable' });
  });
});
