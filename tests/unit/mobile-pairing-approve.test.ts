/**
 * Approve instead of a code (docs/specs/mobile-pairing-approve.md): the one approval funnel on both
 * sides of each gate, the shared Telegram nonce, the Telegram tap check, the signed line, and the
 * agent-awareness migration.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MobilePairingService, APPROVE_REFUSAL, isPairingApproveEnabled, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { pairingApproveLine, pairingApproveMessage } from '../../src/server/mobilePairingApproval.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { PostUpdateMigrator, MOBILE_PAIRING_CLAUDEMD_SECTION, PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_SECTION, PAIRING_APPROVE_BULLET, PAIRING_APPROVE_DASHBOARD_BULLET } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-pairing-approve.test.ts' });
});

function service(opts: { approve?: boolean; lease?: { held: boolean } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpa-unit-'));
  dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false }, ...(opts.approve === undefined ? {} : { approve: { enabled: opts.approve } }) },
  } as unknown as InstarConfig;
  const lease = opts.lease ?? { held: true };
  const deps: MobilePairingDeps = { config, stateDir: dir, holdsLease: () => lease.held, ownerDM: async () => 1 };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  return { svc, config, lease };
}
function pend(svc: MobilePairingService, withNonce?: string) {
  const r = svc.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: makeDevice().publicKey, host: 'h.example' });
  if (!r.ok) throw new Error(r.reason);
  svc.confirm.issue(r.device.id, Date.parse(r.device.expiresAt!));
  if (withNonce) svc.declineNonces.set(withNonce, r.device.id);
  return r.device;
}

describe('approvePending: the one funnel', () => {
  it('activates a waiting phone, drops its code and nonces, and names the proof', () => {
    const { svc } = service();
    const d = pend(svc, 'n1');
    expect(svc.approvePending(d.id, 'telegram-dm')).toBe('approved');
    const after = svc.devices.get(d.id)!;
    expect(after.status).toBe('active');
    expect(after.approvedVia).toBe('telegram-dm');
    expect(svc.confirm.check(d.id, '123456').result).toBe('none');
    expect(svc.declineNonces.has('n1')).toBe(false);
  });

  it('records which owner phone approved', () => {
    const { svc } = service();
    const d = pend(svc);
    expect(svc.approvePending(d.id, 'owner-phone', { approvedBy: 'approver-1' })).toBe('approved');
    expect(svc.devices.get(d.id)).toMatchObject({ approvedVia: 'owner-phone', approvedBy: 'approver-1' });
  });

  it('refuses a repeat, an unknown id and a declined phone', () => {
    const { svc } = service();
    const d = pend(svc);
    expect(svc.approvePending(d.id, 'telegram-dm')).toBe('approved');
    expect(svc.approvePending(d.id, 'telegram-dm')).toBe('ended');
    expect(svc.approvePending('no-such-phone', 'telegram-dm')).toBe('ended');
    const declined = pend(svc);
    svc.declinePending(declined.id);
    expect(svc.approvePending(declined.id, 'telegram-dm')).toBe('ended');
  });

  it('refuses on the pause gate for a phone already waiting', () => {
    const { svc } = service();
    const target = pend(svc);
    const others = [pend(svc), pend(svc), pend(svc), pend(svc)];
    let n = 0;
    for (const o of others) for (let i = 0; i < 3; i++) svc.devices.applyConfirm(o.id, { ok: false, wrongHmac: `w${n++}` });
    expect(svc.devices.pairingPaused()).toBe(true);
    expect(svc.waitingPhones().map((d) => d.id)).toEqual([target.id]);
    expect(svc.approvePending(target.id, 'telegram-dm')).toBe('paused');
    expect(svc.devices.get(target.id)!.status).toBe('pending');
  });

  it('a Telegram-path phone needs the lease; a dashboard-path phone does not', () => {
    const { svc, lease } = service();
    const tg = pend(svc);
    lease.held = false;
    expect(svc.approvePending(tg.id, 'telegram-dm')).toBe('moved');
    const other = service({ lease: { held: false } });
    const dash = pend(other.svc);
    other.svc.holdDashboardCode(dash.id, '123456', Date.parse(dash.expiresAt!));
    expect(other.svc.approvePending(dash.id, 'dashboard-pin')).toBe('approved');
  });

  it('two phones waiting: neither can be approved until one is declined; the code path is untouched', () => {
    const { svc } = service();
    const mine = pend(svc);
    const theirs = pend(svc);
    expect(svc.approvePending(mine.id, 'telegram-dm')).toBe('another-phone-waiting');
    expect(svc.approvePending(theirs.id, 'telegram-dm')).toBe('another-phone-waiting');
    expect(svc.devices.get(mine.id)!.status).toBe('pending');
    svc.declinePending(theirs.id);
    expect(svc.approvePending(mine.id, 'telegram-dm')).toBe('approved');
  });

  it('a failed ledger write approves nothing and consumes nothing', () => {
    const { svc } = service();
    const d = pend(svc, 'n1');
    svc.keyLedger = { recordActivation: () => { throw new Error('disk'); } } as unknown as typeof svc.keyLedger;
    expect(svc.approvePending(d.id, 'telegram-dm')).toBe('failed');
    expect(svc.devices.get(d.id)!.status).toBe('pending');
    expect(svc.declineNonces.has('n1')).toBe(true);
    svc.keyLedger = null;
    expect(svc.approvePending(d.id, 'telegram-dm')).toBe('approved');
  });

  it('the switch off refuses and tells the phone nothing new', () => {
    const { svc, config } = service({ approve: false });
    expect(isPairingApproveEnabled(config)).toBe(false);
    const d = pend(svc);
    expect(svc.approvePending(d.id, 'telegram-dm')).toBe('off');
    expect(svc.waitingFields(d)).toEqual({});
  });

  it('every refusal has a plain sentence with no internal words', () => {
    for (const r of Object.values(APPROVE_REFUSAL)) {
      expect(r.detail).toMatch(/\.$/);
      expect(r.detail).not.toMatch(/nonce|lease|registry|ledger|\d{3}/i);
    }
  });
});

describe('approveByNonce: the same nonce as Decline', () => {
  it('works once; an unknown nonce and a repeat read as ended', () => {
    const { svc } = service();
    const d = pend(svc, 'abc');
    expect(svc.approveByNonce('nope')).toBe('ended');
    expect(svc.approveByNonce('abc')).toBe('approved');
    expect(svc.approveByNonce('abc')).toBe('ended');
    expect(svc.devices.get(d.id)!.approvedVia).toBe('telegram-dm');
  });
  it('after Decline, Approve finds nothing', () => {
    const { svc } = service();
    const d = pend(svc, 'abc');
    expect(svc.declineByNonce('abc')).toBe('declined');
    expect(svc.approveByNonce('abc')).toBe('ended');
    expect(svc.devices.get(d.id)!.status).toBe('declined');
  });
  it('a lease loss clears it', () => {
    const { svc, lease } = service();
    const d = pend(svc, 'abc');
    lease.held = false;
    svc.leaseTick();
    expect(svc.approveByNonce('abc')).toBe('ended');
    expect(svc.devices.get(d.id)!.status).toBe('expired');
  });
});

describe('the Telegram tap', () => {
  const OWNER = 555;
  const NONCE = 'a'.repeat(24);
  function adapter(outcome: 'approved' | 'ended' | 'other' = 'approved') {
    const a = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    const seen: { toast: string[]; handled: string[]; edits: Array<Record<string, unknown>> } = { toast: [], handled: [], edits: [] };
    Object.assign(a, {
      getOwnerUserId: () => OWNER,
      answerCallback: async (_id: unknown, text: string) => { seen.toast.push(text); },
      apiCall: async (_m: string, p: Record<string, unknown>) => { seen.edits.push(p); return {}; },
      mobileApproveHandler: (n: string) => { seen.handled.push(n); return { outcome, text: outcome === 'ended' ? 'This pairing has already ended.' : 'Another phone is also waiting.' }; },
    });
    return { a, seen };
  }
  const tap = { callbackQueryId: 'q1', data: `md:a:${NONCE}`, fromUserId: OWNER, chatId: OWNER, messageId: 9, verified: true };

  it('the owner, verified, in their private chat: approves and closes the message', async () => {
    const { a, seen } = adapter();
    expect(await a.handleMobileApprove(tap)).toBe('approved');
    expect(seen.handled).toEqual([NONCE]);
    expect(seen.edits).toHaveLength(1);
    expect(seen.edits[0]).toMatchObject({ chat_id: OWNER, message_id: 9 });
    expect(JSON.stringify(seen.edits[0])).not.toMatch(/code/i);
  });
  it.each([
    ['an unproven tap', { verified: false }],
    ['another person', { fromUserId: 777 }],
    ['the group chat', { chatId: -100123 }],
    ['a malformed nonce', { data: 'md:a:zz' }],
  ])('%s is refused and reaches nothing', async (_n, change) => {
    const { a, seen } = adapter();
    expect(await a.handleMobileApprove({ ...tap, ...change })).toBe('refused');
    expect(seen.handled).toEqual([]);
    expect(seen.edits).toEqual([]);
    expect(seen.toast[0]).toBe('Only the owner can do this.');
  });
  it('a late tap says so and leaves the message alone', async () => {
    const { a, seen } = adapter('ended');
    expect(await a.handleMobileApprove(tap)).toBe('unknown');
    expect(seen.toast[0]).toBe('This pairing has already ended.');
    expect(seen.edits).toEqual([]);
  });
  it('a refused tap passes on its reason', async () => {
    const { a, seen } = adapter('other');
    expect(await a.handleMobileApprove(tap)).toBe('held');
    expect(seen.toast[0]).toContain('Another phone');
  });
  it('sends both buttons in one row, Approve first, and one button still works', async () => {
    const a = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    const sent: Array<Record<string, unknown>> = [];
    Object.assign(a, { getOwnerUserId: () => OWNER, apiCall: async (_m: string, p: Record<string, unknown>) => { sent.push(p); return { message_id: 1 }; } });
    await a.sendOwnerDMWithButton('x', [{ text: 'Approve', data: 'md:a:n' }, { text: 'Decline', data: 'md:d:n' }]);
    expect(sent[0]!.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Approve', callback_data: 'md:a:n' }, { text: 'Decline', callback_data: 'md:d:n' }]] });
    await a.sendOwnerDMWithButton('x', { text: 'Decline', data: 'md:d:n' });
    expect(sent[1]!.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Decline', callback_data: 'md:d:n' }]] });
    await a.sendOwnerDMWithButton('x', []);
    expect(sent[2]!.reply_markup).toBeUndefined();
  });
});

describe('the signed line', () => {
  it('names the action, the phone and its key', () => {
    expect(pairingApproveLine('approve', 'dev', 'AB-CD')).toBe('approve dev AB-CD');
    expect(pairingApproveMessage('me', 'HOST.example', 'chal', 'approve dev AB-CD')).toBe('instar-pairing-approve-v1\nme\nhost.example\nchal\napprove dev AB-CD');
  });
});

describe('agent awareness', () => {
  type R = { upgraded: string[]; skipped: string[]; errors: string[] };
  const count = (s: string, m: string) => s.split(m).length - 1;

  it('the template carries both lines, once', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(count(md, PAIRING_APPROVE_BULLET)).toBe(1);
    expect(count(md, PAIRING_APPROVE_DASHBOARD_BULLET)).toBe(1);
  });

  it('an existing agent gets them on update, once, and a hand-edited section is left alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpa-md-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const file = path.join(dir, 'CLAUDE.md');
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const run = () => { const r: R = { upgraded: [], skipped: [], errors: [] }; (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r); return r; };
    const installed = (MOBILE_PAIRING_CLAUDEMD_SECTION(4042) + PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_SECTION()).replace(`${PAIRING_APPROVE_BULLET}\n`, '').replace(`${PAIRING_APPROVE_DASHBOARD_BULLET}\n`, '');
    fs.writeFileSync(file, `# CLAUDE.md\n${installed}`);
    expect(run().upgraded).toEqual(expect.arrayContaining(['CLAUDE.md: Mobile pairing link section describes Approve', 'CLAUDE.md: Pairing without Telegram section describes Approve']));
    const once = fs.readFileSync(file, 'utf8');
    expect(count(once, PAIRING_APPROVE_BULLET)).toBe(1);
    expect(count(once, PAIRING_APPROVE_DASHBOARD_BULLET)).toBe(1);
    run();
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
  });

  it('never tells an agent it can approve', () => {
    expect(PAIRING_APPROVE_BULLET).toContain('I can never approve a phone myself');
  });
});
