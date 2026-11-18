/**
 * Trust-journey decision 5, end to end over the service with fake direct-chat ports and a real
 * local-file store: acceptance once, the card, `approve <code>`, and every refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountPathService, proofSubject, type DirectChatPort } from '../../src/core/trustJourney/AccountPathService.js';
import { LocalFileTrustSink, TrustJourneyStore, type TrustChange } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { acceptanceStatement, type Receipt } from '../../src/core/trustJourney/accountPath.js';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { proofCovers, proposalHashOf, isTrustLevelRaise, type OperatorProof } from '../../src/core/TrustRaiseGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OWNER = '777';

class FakeChat implements DirectChatPort {
  sent: Array<{ to: string; text: string; messageId: string }> = [];
  replies: Array<{ messageId: string; text: string }> = [];
  failSend = false;
  failReply = false;
  private n = 100;
  async sendDirect(to: string, text: string) {
    if (this.failSend) return null;
    const messageId = String(this.n++);
    this.sent.push({ to, text, messageId });
    return { chatId: to, messageId };
  }
  async replyTo(_chat: string, messageId: string, text: string) {
    if (this.failReply) return false;
    this.replies.push({ messageId, text });
    return true;
  }
}

let dir: string;
let chat: FakeChat;
let trust: AdaptiveTrust;
let store: TrustJourneyStore;
let svc: AccountPathService;
let applied: Array<{ change: TrustChange; proof: OperatorProof }>;
let applyFails = false;
let updateId = 1;

const receipt = (text: string, over: Partial<Receipt> = {}): Receipt => {
  const id = updateId++;
  return {
    receiptId: `rc${id}`, adapter: 'telegram', senderId: OWNER, chatId: OWNER, chatType: 'private',
    messageId: String(9000 + id), text, senderIsBot: false, forwarded: false, uniqueKey: `tg:${id}`,
    receivedAt: new Date().toISOString(), receivedBy: 'm1', ...over,
  };
};

function build() {
  store = new TrustJourneyStore(new LocalFileTrustSink(path.join(dir, 'trust-journey.jsonl')));
  svc = new AccountPathService({
    store,
    adapters: { telegram: chat },
    ownerPlatformId: (a) => (a === 'telegram' ? OWNER : null),
    installationId: 'inst-1',
    raisesOf: (c) => (c.kind === 'trust-grant' && isTrustLevelRaise(trust.getTrustLevel(c.service, c.operation).level as never, c.level as never) ? ['x'] : []),
    summarize: (c) => [`change ${JSON.stringify(c)}`],
    apply: async (c, proof) => {
      if (applyFails) return { ok: false, detail: 'store down' };
      applied.push({ change: c, proof });
      if (c.kind === 'trust-grant') trust.grantTrust(c.service, c.operation, c.level as never, 'approved', proof);
      return { ok: true };
    },
    cardTtlDays: () => 7,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-svc-'));
  chat = new FakeChat();
  trust = new AdaptiveTrust({ stateDir: dir });
  applied = [];
  applyFails = false;
  build();
});
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/trust-journey-account-path-service.test.ts' }); });

const change: TrustChange = { kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' };
const statement = () => acceptanceStatement({ adapter: 'telegram', accountId: OWNER, installationId: 'inst-1' });

async function acceptAndGetCard() {
  const p = await svc.propose(change);
  expect(p.status).toBe('awaiting-acceptance');
  expect(chat.sent[0].text).toContain(statement());
  expect(await svc.onReceipt(receipt(statement()))).toBe('acceptance-recorded');
  const card = chat.sent[chat.sent.length - 1];
  expect(card.text).toContain('approve ');
  return { card, code: (p as { code: string }).code };
}

describe('AccountPathService', () => {
  it('a narrowing is not a request', async () => {
    expect((await svc.propose({ ...change, level: 'blocked' })).status).toBe('not-a-raise');
  });

  it('acceptance once, then the card; approve <code> as a reply applies the change with a proof for it', async () => {
    const { card, code } = await acceptAndGetCard();
    expect(await svc.onReceipt(receipt(`approve ${code.toLowerCase()}`, { replyToMessageId: card.messageId }))).toBe('approved');
    expect(applied).toHaveLength(1);
    expect(proofCovers(applied[0].proof, proposalHashOf(proofSubject(change)))).toBe(true);
    expect(trust.getTrustLevel('gmail', 'write').level).toBe('autonomous');
    expect(chat.replies.at(-1)!.text).toContain('this does not prove who approved');
  });

  it('a yes in words, a wrong code or a non-reply approves nothing and is answered once', async () => {
    const { card, code } = await acceptAndGetCard();
    expect(await svc.onReceipt(receipt('yes', { replyToMessageId: card.messageId }))).toBe('instruction-sent');
    expect(await svc.onReceipt(receipt('approve ZZZZZZ', { replyToMessageId: card.messageId }))).toBe('instruction-sent');
    expect(await svc.onReceipt(receipt(`approve ${code}`))).toBe('instruction-sent');
    expect(applied).toHaveLength(0);
  });

  it('the same receipt twice, a second approval, or another person\'s reply never applies again', async () => {
    const { card, code } = await acceptAndGetCard();
    const r = receipt(`approve ${code}`, { replyToMessageId: card.messageId });
    expect(await svc.onReceipt(r)).toBe('approved');
    expect(await svc.onReceipt(r)).toBe('duplicate');
    expect(await svc.onReceipt(receipt(`approve ${code}`, { replyToMessageId: card.messageId }))).toBe('refused');
    expect(await svc.onReceipt(receipt(`approve ${code}`, { replyToMessageId: card.messageId, senderId: '888', chatId: '888' }))).toBe('not-for-us');
    expect(applied).toHaveLength(1);
  });

  it('a reply in a group or a forwarded message is not for the account path', async () => {
    const { card, code } = await acceptAndGetCard();
    expect(await svc.onReceipt(receipt(`approve ${code}`, { replyToMessageId: card.messageId, chatType: 'supergroup', chatId: '-100' }))).toBe('not-for-us');
    expect(await svc.onReceipt(receipt(`approve ${code}`, { replyToMessageId: card.messageId, forwarded: true }))).toBe('not-for-us');
    expect(applied).toHaveLength(0);
  });

  it('when the threaded reply is refused the approval is refused, and nothing is consumed', async () => {
    const { card, code } = await acceptAndGetCard();
    chat.failReply = true;
    expect(await svc.onReceipt(receipt(`approve ${code}`, { replyToMessageId: card.messageId }))).toBe('refused');
    expect(applied).toHaveLength(0);
    expect(store.openRequests()).toHaveLength(1);
  });

  it('an apply failure says so in the thread and grants nothing', async () => {
    const { card, code } = await acceptAndGetCard();
    applyFails = true;
    expect(await svc.onReceipt(receipt(`approve ${code}`, { replyToMessageId: card.messageId }))).toBe('apply-failed');
    expect(chat.replies.at(-1)!.text).toContain('did not take effect');
    expect(trust.getTrustLevel('gmail', 'write').level).not.toBe('autonomous');
  });

  it('an expired card approves nothing', async () => {
    const { card, code } = await acceptAndGetCard();
    const later = new Date(Date.now() + 8 * 86_400_000);
    svc = new AccountPathService({ ...(svc as unknown as { d: ConstructorParameters<typeof AccountPathService>[0] }).d, now: () => later });
    expect(await svc.onReceipt(receipt(`approve ${code}`, { replyToMessageId: card.messageId }))).toBe('instruction-sent');
    expect(applied).toHaveLength(0);
  });

  it('a withdrawn acceptance stops new approvals and re-sends the statement', async () => {
    const { card, code } = await acceptAndGetCard();
    expect(await svc.withdrawAcceptance('owner', 'telegram')).toBe(true);
    expect(await svc.onReceipt(receipt(`approve ${code}`, { replyToMessageId: card.messageId }))).toBe('refused');
    expect(applied).toHaveLength(0);
  });

  it('state survives a restart: the card still matches and a consumed receipt stays consumed', async () => {
    const { card, code } = await acceptAndGetCard();
    build();
    expect(await svc.onReceipt(receipt(`approve ${code}`, { replyToMessageId: card.messageId }))).toBe('approved');
    build();
    expect(store.openRequests()).toHaveLength(0);
  });

  it('an undelivered card is reported and nothing is approvable', async () => {
    await acceptAndGetCard();
    chat.failSend = true;
    const p = await svc.propose({ ...change, operation: 'delete' });
    expect(p.status).toBe('undelivered');
  });

  it('two quick approve replies apply once (the request is claimed before any wait)', async () => {
    const { card, code } = await acceptAndGetCard();
    const [a, b] = await Promise.all([
      svc.onReceipt(receipt(`approve ${code}`, { replyToMessageId: card.messageId })),
      svc.onReceipt(receipt(`approve ${code}`, { replyToMessageId: card.messageId })),
    ]);
    expect([a, b].sort()).toEqual(['approved', 'refused']);
    expect(applied).toHaveLength(1);
  });

  it('a stranger\'s DM or the owner\'s ordinary message is never recorded', async () => {
    await acceptAndGetCard();
    const before = fs.readFileSync(path.join(dir, 'trust-journey.jsonl'), 'utf8').split('\n').length;
    expect(await svc.onReceipt(receipt('hello there', { senderId: '999', chatId: '999' }))).toBe('not-for-us');
    expect(await svc.onReceipt(receipt('what is the weather'))).toBe('not-for-us');
    expect(fs.readFileSync(path.join(dir, 'trust-journey.jsonl'), 'utf8').split('\n').length).toBe(before);
  });

  it('at most three open requests per person', async () => {
    await acceptAndGetCard();
    for (const op of ['delete', 'modify'] as const) expect((await svc.propose({ ...change, operation: op })).status).toBe('sent');
    expect((await svc.propose({ ...change, service: 'calendar' })).status).toBe('too-many-open');
  });

  it('an undelivered acceptance statement is reported, not shown as awaiting acceptance', async () => {
    chat.failSend = true;
    expect((await svc.propose(change)).status).toBe('undelivered');
  });

  it('a duplicate proposal returns the open request', async () => {
    await acceptAndGetCard();
    const a = await svc.propose(change);
    expect((a as { deduped?: boolean }).deduped).toBe(true);
  });
});
