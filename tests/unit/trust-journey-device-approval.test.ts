/**
 * Approving a trust raise from the Instar app (docs/specs/app-trust-approval.md), service and store
 * layer: a real local-file store, a fake device registry. Covers Acceptance §1 (service and store):
 * every refusal of `onPresenceApproval`, one acceptance → one raise with proof kind
 * `accepted-device`, concurrent consumptions → one raise, `unknown` when the process stops between
 * consumption and outcome, the first-device and accept-device rules, and the local override.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountPathService, proofSubject, type DeviceDirectory, type DeviceSnapshot, type DirectChatPort } from '../../src/core/trustJourney/AccountPathService.js';
import { LocalFileTrustSink, TrustJourneyStore, type TrustChange, type TrustRecord, type TrustRecordSink } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { acceptanceStatement, UNKNOWN_OUTCOME_TEXT, type Receipt } from '../../src/core/trustJourney/accountPath.js';
import { issueOperatorProofFromConsumedReceipt, proofCovers, proposalHashOf, type OperatorProof } from '../../src/core/TrustRaiseGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const H = (c: string) => c.repeat(64);
const change: TrustChange = { kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' };
const HASH = proposalHashOf(proofSubject(change));

class FakeDevices implements DeviceDirectory {
  map = new Map<string, DeviceSnapshot>();
  notices: Array<[string, string]> = [];
  on = true;
  enabled() { return this.on; }
  get(id: string) { return this.map.get(id) ?? null; }
  notify(subject: string, key: string) { this.notices.push([subject, key]); }
  add(id: string, over: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
    const d: DeviceSnapshot = { deviceId: id, name: `${id} device`, active: true, keyFingerprint: `${id.toUpperCase().padEnd(4, '0').slice(0, 4)}-0000-0000-0000`, presenceKeyHash: H(id[0]!), deviceKind: 'phone', localInstall: false, ...over };
    this.map.set(id, d);
    return d;
  }
}

class FakeChat implements DirectChatPort {
  sent: Array<{ text: string; messageId: string }> = [];
  replies: string[] = [];
  private n = 100;
  async sendDirect(_to: string, text: string) { const messageId = String(this.n++); this.sent.push({ text, messageId }); return { chatId: '777', messageId }; }
  async replyTo(_c: string, _m: string, text: string) { this.replies.push(text); return true; }
}

let dir: string;
let devices: FakeDevices;
let applied: Array<{ change: TrustChange; proof: OperatorProof }>;
let applyImpl: (c: TrustChange, p: OperatorProof) => Promise<{ ok: boolean; detail?: string }>;
let holder = true;
let now = new Date('2026-11-17T10:00:00Z');

function mkStore(sink?: TrustRecordSink) {
  return new TrustJourneyStore(sink ?? new LocalFileTrustSink(path.join(dir, 'trust-journey.jsonl')), () => now);
}
function mkService(store: TrustJourneyStore, chat?: FakeChat) {
  return new AccountPathService({
    store,
    adapters: chat ? { telegram: chat } : {},
    ownerPlatformId: (a) => (chat && a === 'telegram' ? '777' : null),
    installationId: 'inst-1',
    raisesOf: (c) => (c.kind === 'trust-grant' ? ['wider'] : []),
    summarize: () => ['Change: write actions on "gmail": just do it'],
    apply: (c, p) => applyImpl(c, p),
    cardTtlDays: () => 7,
    holdsLease: () => holder,
    devices,
    now: () => now,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-dev-'));
  devices = new FakeDevices();
  applied = [];
  holder = true;
  now = new Date('2026-11-17T10:00:00Z');
  applyImpl = async (c, p) => { applied.push({ change: c, proof: p }); return { ok: true }; };
});
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/trust-journey-device-approval.test.ts' }); });

/** The Mac the app paired locally, accepted as the first device. */
async function acceptMac(svc: AccountPathService) {
  const mac = devices.add('mac', { deviceKind: 'computer', localInstall: true });
  const r = await svc.recordDeviceAcceptance({ deviceId: 'mac', keyFingerprint: mac.keyFingerprint!, presenceKeyHash: mac.presenceKeyHash!, keyPolicy: 'biometryCurrentSet', disclosureHash: H('d') });
  expect(r.status).toBe('recorded');
  return mac;
}
const auth = (requestId: string, over: Record<string, string> = {}) => ({ deviceId: 'mac', keyFingerprint: devices.get('mac')!.keyFingerprint!, host: 'localhost:4040', requestId, proposalHash: HASH, challengeId: `ch${Math.random().toString(16).slice(2, 10)}`, ...over });

describe('propose without a chat', () => {
  it('no chat and no device acceptance: no-approver, with the set-up words', async () => {
    const svc = mkService(mkStore());
    const r = await svc.propose(change);
    expect(r.status).toBe('no-approver');
    expect((r as { message: string }).message).toContain('Changes to approve');
  });

  it('a current device acceptance: the request is recorded for the device and a push notice is sent', async () => {
    const store = mkStore();
    const svc = mkService(store);
    await acceptMac(svc);
    const r = await svc.propose(change);
    expect(r).toMatchObject({ status: 'sent', via: 'device' });
    expect(store.request((r as { requestId: string }).requestId)).toMatchObject({ adapter: 'device', status: 'open' });
    expect(devices.notices.some(([s]) => s === 'trust-request')).toBe(true);
    expect(svc.deviceListing()).toEqual([expect.objectContaining({ status: 'open', proposalHash: HASH, via: 'device' })]);
    // The same change again is the same request.
    expect(await svc.propose(change)).toMatchObject({ status: 'sent', via: 'device', deduped: true });
  });
});

describe('onPresenceApproval', () => {
  let store: TrustJourneyStore;
  let svc: AccountPathService;
  let requestId: string;
  beforeEach(async () => {
    store = mkStore();
    svc = mkService(store);
    await acceptMac(svc);
    requestId = ((await svc.propose(change)) as { requestId: string }).requestId;
  });

  it('accepts once: proof kind accepted-device, the consumption notes the device and acceptance, the outcome is recorded', async () => {
    const r = await svc.onPresenceApproval(auth(requestId));
    expect(r.status).toBe('applied');
    expect((r as { message: string }).message).toContain('not independently verified');
    expect(applied).toHaveLength(1);
    expect(applied[0]!.proof.kind).toBe('accepted-device');
    expect(proofCovers(applied[0]!.proof, HASH)).toBe(true);
    const c = store.consumptionOf(requestId)!;
    expect(c).toMatchObject({ kind: 'accepted-device', deviceId: 'mac', acceptanceId: store.deviceAcceptance('mac')!.acceptanceId });
    expect(store.applyOutcome(requestId)).toMatchObject({ outcome: 'applied' });
    expect((await svc.onPresenceApproval(auth(requestId))).status).toBe('already-approved');
    expect(applied).toHaveLength(1);
    // A restarted app sees the same result.
    const reopened = mkService(mkStore());
    reopened.bindDevices(devices);
    expect(reopened.deviceListing().find((x) => x.requestId === requestId)).toMatchObject({ status: 'applied', approvedOn: 'device' });
  });

  it('refuses an expired request', async () => {
    now = new Date(now.getTime() + 8 * 86_400_000);
    expect(await svc.onPresenceApproval(auth(requestId))).toMatchObject({ status: 'refused', reason: 'request-expired' });
    expect(applied).toHaveLength(0);
  });

  it('refuses a wrong proposal hash', async () => {
    expect(await svc.onPresenceApproval(auth(requestId, { proposalHash: H('e') }))).toMatchObject({ status: 'refused', reason: 'proposal-changed' });
    expect(applied).toHaveLength(0);
  });

  it('refuses a device with no acceptance', async () => {
    const phone = devices.add('phone');
    expect(await svc.onPresenceApproval(auth(requestId, { deviceId: 'phone', keyFingerprint: phone.keyFingerprint! }))).toMatchObject({ status: 'refused', reason: 'no-acceptance' });
    expect(applied).toHaveLength(0);
  });

  it('refuses after the acceptance is withdrawn', async () => {
    expect(await svc.withdrawDeviceAcceptance('mac')).toBe(1);
    expect(await svc.onPresenceApproval(auth(requestId))).toMatchObject({ status: 'refused', reason: 'acceptance-withdrawn' });
    expect(applied).toHaveLength(0);
  });

  it('refuses a revoked device, and withdraws its acceptance', async () => {
    devices.map.set('mac', { ...devices.get('mac')!, active: false });
    expect(await svc.onPresenceApproval(auth(requestId))).toMatchObject({ status: 'refused', reason: 'device-not-active' });
    expect(store.deviceAcceptance('mac')).toBeNull();
    expect(applied).toHaveLength(0);
  });

  it('refuses a key replaced under the same deviceId, and withdraws the acceptance', async () => {
    devices.map.set('mac', { ...devices.get('mac')!, presenceKeyHash: H('9') });
    expect(await svc.onPresenceApproval(auth(requestId))).toMatchObject({ status: 'refused', reason: 'key-mismatch' });
    expect(store.deviceAcceptance('mac')).toBeNull();
    expect(applied).toHaveLength(0);
  });

  it('refuses an authorization whose key fingerprint is not the acceptance\'s', async () => {
    expect(await svc.onPresenceApproval(auth(requestId, { keyFingerprint: 'FFFF-FFFF-FFFF-FFFF' }))).toMatchObject({ status: 'refused', reason: 'key-mismatch' });
    expect(applied).toHaveLength(0);
  });

  it('a machine that is not the serving-lease holder refuses', async () => {
    holder = false;
    expect(await svc.onPresenceApproval(auth(requestId))).toMatchObject({ status: 'not-holder' });
    expect(applied).toHaveLength(0);
  });

  it('two concurrent consumptions of one request (two service instances, one store) produce exactly one raise', async () => {
    const other = mkService(store);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // The first apply waits, so both approvals are in flight together.
    applyImpl = async (c, p) => { await gate; applied.push({ change: c, proof: p }); return { ok: true }; };
    const both = Promise.all([svc.onPresenceApproval(auth(requestId)), other.onPresenceApproval(auth(requestId))]);
    setTimeout(release, 20);
    const results = (await both).map((r) => r.status).sort();
    expect(results).toEqual(['already-approved', 'applied']);
    expect(applied).toHaveLength(1);
  });

  it('process stops between consumption and outcome: the request reads unknown, and nothing retries it', async () => {
    // The apply never returns (the process stops while it runs).
    applyImpl = () => new Promise(() => {});
    void svc.onPresenceApproval(auth(requestId));
    await new Promise((r) => setTimeout(r, 30));
    expect(store.consumptionOf(requestId)).not.toBeNull();
    // A restart: a new store over the same file and a new service.
    const restarted = mkService(mkStore());
    const row = restarted.deviceListing().find((x) => x.requestId === requestId)!;
    expect(row).toMatchObject({ status: 'unknown', message: UNKNOWN_OUTCOME_TEXT });
    applyImpl = async (c, p) => { applied.push({ change: c, proof: p }); return { ok: true }; };
    expect((await restarted.onPresenceApproval(auth(requestId))).status).toBe('already-approved');
    expect(applied).toHaveLength(0);
  });

  it('an outcome that cannot be written answers unknown, never applied', async () => {
    const file = path.join(dir, 'flaky.jsonl');
    const inner = new LocalFileTrustSink(file);
    const sink: TrustRecordSink = { description: 'flaky', loadAll: () => inner.loadAll(), append: (k: string, r: TrustRecord) => (r.recordType === 'apply-outcome' ? Promise.resolve(false) : inner.append(k, r)) };
    const s2 = mkStore(sink);
    const svc2 = mkService(s2);
    await acceptMac(svc2);
    const id = ((await svc2.propose(change)) as { requestId: string }).requestId;
    expect(await svc2.onPresenceApproval(auth(id))).toMatchObject({ status: 'unknown', message: UNKNOWN_OUTCOME_TEXT });
    expect(svc2.deviceListing().find((x) => x.requestId === id)).toMatchObject({ status: 'unknown' });
  });

  it('a failed apply is recorded not-applied and listed so', async () => {
    applyImpl = async () => ({ ok: false, detail: 'the settings changed' });
    expect((await svc.onPresenceApproval(auth(requestId))).status).toBe('not-applied');
    expect(svc.deviceListing().find((x) => x.requestId === requestId)).toMatchObject({ status: 'not-applied', detail: 'the settings changed' });
  });
});

describe('a chat approval and a device approval of the same request', () => {
  it('arriving together produce exactly one raise; the loser is told it was already approved', async () => {
    const chat = new FakeChat();
    const store = mkStore();
    const svc = mkService(store, chat);
    await acceptMac(svc);
    const statement = acceptanceStatement({ adapter: 'telegram', accountId: '777', installationId: 'inst-1' });
    const p = await svc.propose(change);
    let n = 0;
    const receipt = (text: string, replyTo?: string): Receipt => ({ receiptId: `rc${++n}`, adapter: 'telegram', senderId: '777', chatId: '777', chatType: 'private', messageId: String(900 + n), ...(replyTo ? { replyToMessageId: replyTo } : {}), text, senderIsBot: false, forwarded: false, uniqueKey: `tg:${n}`, receivedAt: now.toISOString(), receivedBy: 'm1' });
    expect(await svc.onReceipt(receipt(statement))).toBe('acceptance-recorded');
    const card = chat.sent.at(-1)!;
    const requestId = (p as { requestId: string }).requestId;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    applyImpl = async (c, pr) => { await gate; applied.push({ change: c, proof: pr }); return { ok: true }; };
    // A second service over the same store, so the store's key (not the in-process set) decides.
    const deviceSide = mkService(store);
    const both = Promise.all([svc.onReceipt(receipt(`approve ${(p as { code: string }).code}`, card.messageId)), deviceSide.onPresenceApproval(auth(requestId))]);
    setTimeout(release, 20);
    const [chatOutcome, deviceOutcome] = await both;
    expect(applied).toHaveLength(1);
    expect([chatOutcome === 'approved', deviceOutcome.status === 'applied'].filter(Boolean)).toHaveLength(1);
    if (chatOutcome !== 'approved') expect(chat.replies.at(-1)).toContain('already approved');
    else expect(deviceOutcome.status).toBe('already-approved');
    expect(store.applyOutcome(requestId)).toMatchObject({ outcome: 'applied' });
  });
});

describe('recording a device acceptance', () => {
  it('the first device must be paired locally; a computer needs Touch ID; a phone may use its passcode', async () => {
    const svc = mkService(mkStore());
    const phone = devices.add('phone');
    expect(await svc.recordDeviceAcceptance({ deviceId: 'phone', keyFingerprint: phone.keyFingerprint!, presenceKeyHash: phone.presenceKeyHash!, keyPolicy: 'userPresence', disclosureHash: H('d') })).toMatchObject({ status: 'refused', reason: 'approval-needed' });
    const mac = devices.add('mac', { deviceKind: 'computer', localInstall: true });
    expect(await svc.recordDeviceAcceptance({ deviceId: 'mac', keyFingerprint: mac.keyFingerprint!, presenceKeyHash: mac.presenceKeyHash!, keyPolicy: 'userPresence', disclosureHash: H('d') })).toMatchObject({ status: 'refused', reason: 'key-policy-not-allowed' });
    // The iPhone the Mac app paired during setup (also local-install) can take the first acceptance with its passcode policy.
    const local = devices.add('lphone', { localInstall: true });
    expect(await svc.recordDeviceAcceptance({ deviceId: 'lphone', keyFingerprint: local.keyFingerprint!, presenceKeyHash: local.presenceKeyHash!, keyPolicy: 'userPresence', disclosureHash: H('d') })).toMatchObject({ status: 'recorded', via: 'local-install' });
  });

  it('only one device takes the first acceptance while it is current; after every acceptance is withdrawn a new first pairing may', async () => {
    const svc = mkService(mkStore());
    await acceptMac(svc);
    const p2 = devices.add('lphone', { localInstall: true });
    const input = { deviceId: 'lphone', keyFingerprint: p2.keyFingerprint!, presenceKeyHash: p2.presenceKeyHash!, keyPolicy: 'userPresence', disclosureHash: H('d') };
    expect(await svc.recordDeviceAcceptance(input)).toMatchObject({ status: 'refused', reason: 'approval-needed' });
    expect(await svc.withdrawDeviceAcceptance(null)).toBe(1);
    expect(await svc.recordDeviceAcceptance(input)).toMatchObject({ status: 'recorded', via: 'local-install' });
  });

  it('a later device needs an unexpired approval from a currently accepted device, for exactly its key and disclosure, used once', async () => {
    const store = mkStore();
    const svc = mkService(store);
    await acceptMac(svc);
    const phone = devices.add('phone');
    const input = { deviceId: 'phone', keyFingerprint: phone.keyFingerprint!, presenceKeyHash: phone.presenceKeyHash!, keyPolicy: 'userPresence', disclosureHash: H('d') };
    const exp = new Date(now.getTime() + 60_000).toISOString();
    // A wrong fingerprint is refused at the approval.
    expect(await svc.recordDeviceApproval({ approverDeviceId: 'mac', deviceId: 'phone', keyFingerprint: 'AAAA-0000-0000-0000', disclosureHash: H('d'), expiresAt: exp })).toMatchObject({ status: 'refused', reason: 'key-mismatch' });
    // An approval for another disclosure does not count.
    expect((await svc.recordDeviceApproval({ approverDeviceId: 'mac', deviceId: 'phone', keyFingerprint: phone.keyFingerprint!, disclosureHash: H('f'), expiresAt: exp })).status).toBe('recorded');
    expect(await svc.recordDeviceAcceptance(input)).toMatchObject({ status: 'refused', reason: 'approval-needed' });
    // An expired one does not count.
    expect((await svc.recordDeviceApproval({ approverDeviceId: 'mac', deviceId: 'phone', keyFingerprint: phone.keyFingerprint!, disclosureHash: H('d'), expiresAt: new Date(now.getTime() - 1).toISOString() })).status).toBe('recorded');
    expect(await svc.recordDeviceAcceptance(input)).toMatchObject({ status: 'refused', reason: 'approval-needed' });
    // A good one counts once.
    expect((await svc.recordDeviceApproval({ approverDeviceId: 'mac', deviceId: 'phone', keyFingerprint: phone.keyFingerprint!, disclosureHash: H('d'), expiresAt: exp })).status).toBe('recorded');
    expect(await svc.recordDeviceAcceptance(input)).toMatchObject({ status: 'recorded', via: 'accept-device' });
    expect(await svc.withdrawDeviceAcceptance('phone')).toBe(1);
    expect(await svc.recordDeviceAcceptance(input)).toMatchObject({ status: 'refused', reason: 'approval-needed' });
  });

  it('an approval stops counting when the approving device\'s acceptance is withdrawn', async () => {
    const svc = mkService(mkStore());
    await acceptMac(svc);
    const phone = devices.add('phone');
    await svc.recordDeviceApproval({ approverDeviceId: 'mac', deviceId: 'phone', keyFingerprint: phone.keyFingerprint!, disclosureHash: H('d'), expiresAt: new Date(now.getTime() + 60_000).toISOString() });
    await svc.withdrawDeviceAcceptance('mac');
    expect(await svc.recordDeviceAcceptance({ deviceId: 'phone', keyFingerprint: phone.keyFingerprint!, presenceKeyHash: phone.presenceKeyHash!, keyPolicy: 'userPresence', disclosureHash: H('d') })).toMatchObject({ status: 'refused', reason: 'approval-needed' });
  });

  it('a device that has no acceptance cannot approve another', async () => {
    const svc = mkService(mkStore());
    devices.add('phone');
    const other = devices.add('other');
    expect(await svc.recordDeviceApproval({ approverDeviceId: 'phone', deviceId: 'other', keyFingerprint: other.keyFingerprint!, disclosureHash: H('d'), expiresAt: new Date(now.getTime() + 60_000).toISOString() })).toMatchObject({ status: 'refused', reason: 'no-acceptance' });
  });

  it('a non-holder records nothing', async () => {
    holder = false;
    const svc = mkService(mkStore());
    const mac = devices.add('mac', { deviceKind: 'computer', localInstall: true });
    expect(await svc.recordDeviceAcceptance({ deviceId: 'mac', keyFingerprint: mac.keyFingerprint!, presenceKeyHash: mac.presenceKeyHash!, keyPolicy: 'biometryCurrentSet', disclosureHash: H('d') })).toMatchObject({ status: 'not-holder' });
  });
});

describe('the iPhone the Mac app pairs during setup (a Mac without Touch ID)', () => {
  it('a phone approved by the local-install device (firstPairing) may take the first acceptance; any other phone may not', async () => {
    const svc = mkService(mkStore());
    devices.add('mac', { deviceKind: 'computer', localInstall: true, presenceKeyHash: null });
    const setup = devices.add('sphone', { firstPairing: true });
    const other = devices.add('ophone');
    expect(await svc.recordDeviceAcceptance({ deviceId: 'ophone', keyFingerprint: other.keyFingerprint!, presenceKeyHash: other.presenceKeyHash!, keyPolicy: 'userPresence', disclosureHash: H('d') })).toMatchObject({ status: 'refused', reason: 'approval-needed' });
    expect(await svc.recordDeviceAcceptance({ deviceId: 'sphone', keyFingerprint: setup.keyFingerprint!, presenceKeyHash: setup.presenceKeyHash!, keyPolicy: 'userPresence', disclosureHash: H('d') })).toMatchObject({ status: 'recorded', via: 'local-install' });
  });

  it('a setup-paired phone cannot use the local override (only the device on the agent\'s computer can)', async () => {
    const svc = mkService(mkStore());
    const setup = devices.add('sphone', { firstPairing: true });
    const r = await svc.recordDeviceAcceptance({ deviceId: 'sphone', keyFingerprint: setup.keyFingerprint!, presenceKeyHash: H('z'), keyPolicy: 'userPresence', disclosureHash: H('d'),
      override: { replaceKey: () => ({ ok: true, presenceKeyHash: H('z') }) } });
    expect(r).toMatchObject({ status: 'refused', reason: 'not-local-device' });
  });
});

describe('the switch off (mobilePairing.trustApproval)', () => {
  it('no device counts as an approver, so a proposal with no chat answers no-approver instead of a request nobody can approve', async () => {
    const svc = mkService(mkStore());
    await acceptMac(svc);
    devices.on = false;
    expect((await svc.propose(change)).status).toBe('no-approver');
    devices.on = true;
    expect((await svc.propose(change)).status).toBe('sent');
  });
});

describe('two eligible devices taking the first acceptance at the same moment', () => {
  it('exactly one wins; the other is told to get an approval', async () => {
    const svc = mkService(mkStore());
    const mac = devices.add('mac', { deviceKind: 'computer', localInstall: true });
    const phone = devices.add('sphone', { firstPairing: true });
    const [a, b] = await Promise.all([
      svc.recordDeviceAcceptance({ deviceId: 'mac', keyFingerprint: mac.keyFingerprint!, presenceKeyHash: mac.presenceKeyHash!, keyPolicy: 'biometryCurrentSet', disclosureHash: H('d') }),
      svc.recordDeviceAcceptance({ deviceId: 'sphone', keyFingerprint: phone.keyFingerprint!, presenceKeyHash: phone.presenceKeyHash!, keyPolicy: 'userPresence', disclosureHash: H('d') }),
    ]);
    expect([a.status, b.status].filter((s) => s === 'recorded')).toHaveLength(1);
    expect([a, b].find((r) => r.status !== 'recorded')).toMatchObject({ status: 'refused', reason: 'approval-needed' });
  });
});

describe('a new pairing is shown on the approving devices', () => {
  it('no current acceptance: no notice; with one: a trust-device-change notice keyed to the new device', async () => {
    const svc = mkService(mkStore());
    await svc.noteDevicePaired('newphone');
    expect(devices.notices.filter(([, k]) => k.startsWith('trust-device-paired'))).toEqual([]);
    await acceptMac(svc);
    await svc.noteDevicePaired('newphone');
    expect(devices.notices).toContainEqual(['trust-device-change', 'trust-device-paired:newphone']);
  });
});

describe('the local override', () => {
  const override = (svc: AccountPathService, deviceId: string, newHash: string) => {
    const snap = devices.get(deviceId)!;
    return svc.recordDeviceAcceptance({
      deviceId, keyFingerprint: snap.keyFingerprint!, presenceKeyHash: newHash, keyPolicy: snap.deviceKind === 'computer' ? 'biometryCurrentSet' : 'userPresence', disclosureHash: H('d'),
      override: { replaceKey: () => { devices.map.set(deviceId, { ...devices.get(deviceId)!, presenceKeyHash: newHash }); return { ok: true, presenceKeyHash: newHash }; } },
    });
  };

  it('replacing the key revokes the old one, withdraws its acceptance and records the new one (no other device)', async () => {
    const store = mkStore();
    const svc = mkService(store);
    await acceptMac(svc);
    const old = store.deviceAcceptance('mac')!;
    const r = await override(svc, 'mac', H('7'));
    expect(r).toMatchObject({ status: 'recorded', via: 'local-override', withdrew: old.acceptanceId });
    expect(store.deviceAcceptance('mac')).toMatchObject({ via: 'local-override', presenceKeyHash: H('7') });
    expect(store.deviceAcceptanceHistory().find((a) => a.acceptanceId === old.acceptanceId)!.withdrawn).toBe(true);
    expect(devices.notices.some(([s]) => s === 'trust-device-change')).toBe(true);
  });

  it('works while another device approves too', async () => {
    const store = mkStore();
    const svc = mkService(store);
    await acceptMac(svc);
    const phone = devices.add('phone');
    await svc.recordDeviceApproval({ approverDeviceId: 'mac', deviceId: 'phone', keyFingerprint: phone.keyFingerprint!, disclosureHash: H('d'), expiresAt: new Date(now.getTime() + 60_000).toISOString() });
    expect((await svc.recordDeviceAcceptance({ deviceId: 'phone', keyFingerprint: phone.keyFingerprint!, presenceKeyHash: phone.presenceKeyHash!, keyPolicy: 'userPresence', disclosureHash: H('d') })).status).toBe('recorded');
    expect(await override(svc, 'mac', H('6'))).toMatchObject({ status: 'recorded', via: 'local-override' });
    expect(store.currentDeviceAcceptances().map((a) => a.deviceId).sort()).toEqual(['mac', 'phone']);
  });

  it('a device not paired locally is refused and its key is untouched', async () => {
    const svc = mkService(mkStore());
    devices.add('phone');
    let replaced = false;
    const snap = devices.get('phone')!;
    const r = await svc.recordDeviceAcceptance({ deviceId: 'phone', keyFingerprint: snap.keyFingerprint!, presenceKeyHash: H('5'), keyPolicy: 'userPresence', disclosureHash: H('d'), override: { replaceKey: () => { replaced = true; return { ok: true, presenceKeyHash: H('5') }; } } });
    expect(r).toMatchObject({ status: 'refused', reason: 'not-local-device' });
    expect(replaced).toBe(false);
  });
});

describe('the proof', () => {
  it('accepted-device is issued only by the single issuer and is covered alongside accepted-account; a forged object is not', () => {
    const dev = issueOperatorProofFromConsumedReceipt({ proposalHash: HASH, receiptRef: 'c:dev:1', acceptanceRef: 'dacc-1', principal: 'owner', kind: 'accepted-device' });
    const acct = issueOperatorProofFromConsumedReceipt({ proposalHash: HASH, receiptRef: 'c:1', acceptanceRef: 'acc-1', principal: 'owner' });
    expect(dev.kind).toBe('accepted-device');
    expect(acct.kind).toBe('accepted-account');
    expect(proofCovers(dev, HASH)).toBe(true);
    expect(proofCovers(acct, HASH)).toBe(true);
    expect(proofCovers(dev, H('0'))).toBe(false);
    expect(proofCovers({ ...dev } as OperatorProof, HASH)).toBe(false);
    expect(() => issueOperatorProofFromConsumedReceipt({ proposalHash: HASH, receiptRef: 'x', acceptanceRef: 'y', principal: 'owner', kind: 'pin' as never })).toThrow();
  });
});
