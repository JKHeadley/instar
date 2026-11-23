import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveEffect, exactReadToolNames } from '../../src/data/effect-kinds.js';
import { AccountPathService } from '../../src/core/trustJourney/AccountPathService.js';
import { LocalFileTrustSink, TrustJourneyStore } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { approvalPresentation, isActionableApproval, traceApprovalRefusal } from '../../src/core/trustJourney/approvalPresentation.js';
import { acceptanceStatement } from '../../src/core/trustJourney/accountPath.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/approval-request-delivery.test.ts' }); });
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-local-')); dirs.push(dir);
  const store = new TrustJourneyStore(new LocalFileTrustSink(path.join(dir, 'trust.jsonl')));
  let owner = '123';
  const sent: string[] = [];
  const send = vi.fn(async (_to: string, text: string) => { expect(store.openRequests().length).toBeGreaterThan(0); sent.push(text); return { chatId: owner, messageId: String(sent.length) }; });
  const reply = vi.fn(async () => true);
  const svc = new AccountPathService({ store, adapters: { telegram: { sendDirect: send, replyTo: reply } }, ownerPlatformId: () => owner, installationId: 'test', raisesOf: () => ['raise'], summarize: () => ['One exact change'], apply: async () => ({ ok: true }), cardTtlDays: () => 7 });
  const change = { kind: 'trust-grant' as const, service: 'mail', operation: 'write', level: 'autonomous' };
  const accept = async () => svc.onReceipt({ receiptId: 'r-'+owner, uniqueKey: 'r-'+owner, adapter: 'telegram', senderId: owner, chatId: owner, chatType: 'private', messageId: '80', text: acceptanceStatement({ adapter: 'telegram', accountId: owner, installationId: 'test' }), senderIsBot: false, forwarded: false, receivedAt: new Date().toISOString(), receivedBy: 'local' });
  return { dir, store, svc, change, send, sent, reply, accept, owner: (v: string) => { owner = v; } };
}
describe('local approval evidence', () => {
  it('only the exact observed connector name gains the read contract', () => {
    expect(deriveEffect('mcp__codex_apps__github__fetch_pr', { repository: 'public' })?.operation).toBe('read');
    expect(exactReadToolNames()).toContain('mcp__codex_apps__github__fetch_pr');
    for (const name of ['mcp__codex_apps__github_fetch_pr', 'mcp__codex_apps__github__fetch__pr', 'mcp__codex_apps__github__create_pr', 'mcp__codex_apps__github__delete_pr', 'mcp__codex_apps__github__fetch_pr_delete']) expect(deriveEffect(name, {})?.operation).not.toBe('read');
    expect(deriveEffect('mcp__playwright__browser_type', { element: 'Password' })?.operation).toBe('sign-in');
  });
  it('records before accepted-chat delivery and returns a real anchored wait', async () => {
    const r = rig(); await r.accept();
    const ask = await r.svc.propose(r.change);
    expect(ask.status).toBe('sent');
    expect(r.store.openRequests()[0].cardMessageId).toBe('1');
    const wire = approvalPresentation(ask);
    expect(wire.action).toBe('ask'); expect(isActionableApproval(wire.approval)).toBe(true);
    expect(JSON.stringify(wire)).not.toContain(r.store.openRequests()[0].code);
    expect(JSON.stringify(wire)).not.toContain(r.store.openRequests()[0].requestId);
  });
  it('withdrawal during asynchronous device lookup never returns a stale wait', async () => {
    const r = rig(); await r.accept(); await r.svc.propose(r.change);
    const id = r.store.openRequests()[0].requestId;
    let lookups = 0;
    vi.spyOn(r.svc as never, 'approvingDevices' as never).mockImplementation(async () => {
      if (++lookups === 2) await r.store.write('request-status', { requestId: id, status: 'withdrawn' });
      return [];
    });
    expect(approvalPresentation(await r.svc.propose(r.change)).action).toBe('block');
  });
  it('initial persistence failure asks nobody and never reports waiting', async () => {
    const r = rig(); await r.accept(); vi.spyOn(r.store, 'write').mockResolvedValue({ ok: false } as never);
    const ask = await r.svc.propose(r.change); expect(ask.status).toBe('not-recorded'); expect(r.send).not.toHaveBeenCalled(); expect(approvalPresentation(ask).action).toBe('block');
  });
  it('a physical card acknowledgement with failed anchor persistence remains unconfirmed and never resends', async () => {
    const r = rig(); await r.accept();
    const original = r.store.write.bind(r.store);
    vi.spyOn(r.store, 'write').mockImplementation((type, fields, key) => key?.endsWith(':card')
      ? Promise.resolve({ ok: false, recordKey: key }) : original(type, fields, key));
    const first = approvalPresentation(await r.svc.propose(r.change));
    expect(first.action).toBe('block'); expect(first.approval.status).toBe('unconfirmed');
    expect(r.store.openRequests()).toHaveLength(1); expect(r.store.openRequests()[0].cardMessageId).toBe('');
    expect(approvalPresentation(await r.svc.propose(r.change)).action).toBe('block'); expect(r.send).toHaveBeenCalledTimes(1);
  });
  it('a throwing sender and its anchorless duplicate stay unconfirmed without a resend', async () => {
    const r = rig(); await r.accept(); r.send.mockRejectedValue(new Error('network lost'));
    expect(approvalPresentation(await r.svc.propose(r.change)).action).toBe('block');
    expect(approvalPresentation(await r.svc.propose(r.change)).approval.status).toBe('unconfirmed'); expect(r.send).toHaveBeenCalledTimes(1);
  });
  it('an unbound legacy prerequisite marker never makes an undelivered duplicate actionable', async () => {
    const r = rig(); r.send.mockRejectedValue(new Error('lost'));
    await r.svc.propose(r.change);
    await r.store.write('acceptance-sent', { principal: 'owner', adapter: 'telegram', statementMessageId: 'old' });
    expect(approvalPresentation(await r.svc.propose(r.change)).action).toBe('block');
  });
  it('actual current-owner acceptance replaces a former account record', async () => {
    const r = rig(); await r.accept(); r.owner('456');
    expect(await r.accept()).toBe('acceptance-recorded'); expect(r.store.acceptance('owner', 'telegram')?.accountId).toBe('456');
    expect((await r.svc.propose(r.change)).status).toBe('sent');
  });
  it('failed acceptance persistence does not acknowledge success', async () => {
    const r = rig(); vi.spyOn(r.store, 'write').mockResolvedValue({ ok: false } as never);
    expect(await r.accept()).not.toBe('acceptance-recorded'); expect(r.reply.mock.calls.flat().join(' ')).not.toContain('Recorded.');
  });
  it('missing or withdrawn acceptance cannot make an old card an actionable wait', async () => {
    const r = rig(); await r.accept(); await r.svc.propose(r.change); await r.svc.withdrawAcceptance('owner', 'telegram');
    expect(approvalPresentation(await r.svc.propose(r.change)).action).toBe('block');
  });
  it.each([undefined, {}, { version: 0, status: 'sent', surface: 'direct-chat' }, { version: 1, status: 'sent', surface: 'accepted-device' }, { version: 1, status: 'unconfirmed', surface: 'direct-chat' }])('unsupported evidence refuses: %j', (a) => expect(isActionableApproval(a)).toBe(false));
  it('writes actual local refusal evidence and reports storage failure', () => {
    const r = rig(); expect(traceApprovalRefusal(r.dir, { status: 'not-opened', machine: 'test', disposition: 'local' })).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, 'logs/approval-refusals.jsonl'), 'utf8')).status).toBe('not-opened');
    const bad = path.join(r.dir, 'file'); fs.writeFileSync(bad, 'x'); expect(traceApprovalRefusal(bad, { status: 'unconfirmed', machine: 'test', disposition: 'local' })).toBe(false);
  });
});
