/**
 * Pending-accept markers (docs/specs/a2a-pairing-invite-link.md §8; live walk 2026-10-20):
 * an invite waiting for this operator's approval lives only in the engine's memory, so a restart
 * drops it. A secret-free marker turns that into a notice: on the dashboard and, once, on Telegram.
 *
 * Real engine, real trust manager and store, real files in a temp dir. "Restart" = a new marker
 * object and a new engine over the same state dir, which is exactly what a server start builds.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { PairingInviteStore } from '../../../src/threadline/PairingInviteStore.js';
import { PairingInviteFlow } from '../../../src/threadline/PairingInviteFlow.js';
import {
  MarkedPairingInviteFlow, PairingPendingAcceptMarkers, PENDING_ACCEPT_MARKERS_FILE, markerIdFor, EXP_TOO_FAR_REASON,
} from '../../../src/threadline/PairingPendingAcceptMarkers.js';
import { PairingInviteTelegram, restartNoticeText, formatExpiry } from '../../../src/threadline/PairingInviteTelegram.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { decodeInvite, findInviteToken, macKey, encodeInvite, INVITE_MAX_TTL_MS } from '../../../src/threadline/PairingInvite.js';

const T0 = Date.parse('2026-10-20T20:00:00Z');

function agent(name: string, clock: { t: number }, opts: { dir?: string; sendThrows?: () => boolean } = {}) {
  const kp = generateIdentityKeyPair();
  const pub = kp.publicKey.toString('hex');
  const fp = pub.slice(0, 32);
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `pending-marker-${name}-`));
  const now = () => new Date(clock.t);
  const trust = new AgentTrustManager({ stateDir: dir });
  const store = new PairingInviteStore(dir, now);
  const sent: Array<{ to: string; op: string }> = [];
  const deps = {
    store, trust, identity: () => ({ fp, publicKeyHex: pub, privateKey: kp.privateKey }),
    relayKeyFor: async () => null,
    sendPlaintext: (to: string, op: string) => { if (opts.sendThrows?.()) throw new Error('relay down'); sent.push({ to, op }); },
    sendToKey: (to: string, _k: string, op: string) => { sent.push({ to, op }); },
    notify: () => {},
    ownName: () => ({ owner: `${name}-owner`, agent: name }),
    now,
    schedule: (fn: () => void) => fn(),
  };
  return { fp, dir, deps, sent, now };
}

/** B's side as a server start builds it: markers converted, then the marked engine. */
function bootRecipient(dir: string, deps: ConstructorParameters<typeof PairingInviteFlow>[0], now: () => Date) {
  const markers = new PairingPendingAcceptMarkers(dir, { now });
  const notices = markers.convertAfterRestart();
  const flow = new MarkedPairingInviteFlow(deps, markers);
  return { markers, flow, notices };
}

function setup(ttlMin = 60) {
  const clock = { t: T0 };
  const A = agent('Scout', clock);
  const inviter = new PairingInviteFlow(A.deps);
  const inv = inviter.createInvite({ ttlMs: ttlMin * 60_000 }) as { ok: true; iid: string; message: string; exp: string };
  let failSend = false;
  const B = agent('Carl', clock, { sendThrows: () => failSend });
  const boot = bootRecipient(B.dir, B.deps, B.now);
  const markerFile = path.join(B.dir, 'threadline', PENDING_ACCEPT_MARKERS_FILE);
  return { clock, A, B, inv, markerFile, ...boot, setFailSend: (v: boolean) => { failSend = v; } };
}

const readFile = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

describe('pending-accept markers: lifecycle', () => {
  it('a pasted invite writes a marker that holds no secret: not K, not S, not the invite text, not the invite id', async () => {
    const { flow, inv, markerFile } = setup();
    const r = await flow.receiveInvite(`Fwd from Justin: ${inv.message}`);
    expect(r.ok).toBe(true);

    const raw = readFile(markerFile);
    expect(raw).not.toBeNull();
    const token = findInviteToken(inv.message)!;
    const decoded = decodeInvite(token);
    expect(decoded.ok).toBe(true);
    const S = (decoded as { invite: { secret: string } }).invite.secret;
    const K = macKey(S, inv.iid).toString('hex');
    // Control: the values we search for are real and non-trivial, so "absent" means something.
    expect(S).toMatch(/^[0-9a-f]{64}$/);
    expect(K).toMatch(/^[0-9a-f]{64}$/);
    for (const forbidden of [S, K, token, token.slice(7, 47), inv.message, inv.iid]) {
      expect(raw!.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // ...and the base64 forms of the secret bytes, in case a future writer serialises a Buffer.
    expect(raw).not.toContain(Buffer.from(S, 'hex').toString('base64'));
    expect(raw).not.toContain(Buffer.from(K, 'hex').toString('base64'));

    const parsed = JSON.parse(raw!);
    expect(parsed.markers).toHaveLength(1);
    expect(parsed.markers[0]).toMatchObject({ id: markerIdFor(inv.iid), claimedAgent: 'Scout', claimedOwner: 'Scout-owner', exp: inv.exp, state: 'pending' });
    expect(Object.keys(parsed.markers[0]).sort()).toEqual(['claimedAgent', 'claimedOwner', 'exp', 'id', 'recordedAt', 'state']);
    expect(fs.statSync(markerFile).mode & 0o777).toBe(0o600);
  });

  it('approving (the accept is sent) deletes the marker', async () => {
    const { flow, inv, markerFile, A } = setup();
    await flow.receiveInvite(inv.message);
    expect(flow.approveAccept(inv.iid)).toMatchObject({ ok: true });
    expect(readFile(markerFile)).toBeNull();
    expect(A.deps.store).toBeTruthy();
  });

  it('declining deletes the marker', async () => {
    const { flow, inv, markerFile } = setup();
    await flow.receiveInvite(inv.message);
    expect(flow.declineAccept(inv.iid)).toMatchObject({ ok: true });
    expect(readFile(markerFile)).toBeNull();
  });

  it('an accept that could not be sent stays pending, and so does its marker', async () => {
    const { flow, inv, markerFile, setFailSend } = setup();
    await flow.receiveInvite(inv.message);
    setFailSend(true);
    expect(flow.approveAccept(inv.iid).ok).toBe(false);
    expect(flow.listPendingAccepts().map((p) => p.iid)).toEqual([inv.iid]);
    expect(JSON.parse(readFile(markerFile)!).markers[0].state).toBe('pending');
  });

  it('expiry deletes the marker (the engine drops the accept on its next listing)', async () => {
    const { flow, inv, markerFile, clock } = setup(30);
    await flow.receiveInvite(inv.message);
    clock.t = T0 + 31 * 60_000;
    expect(flow.listPendingAccepts()).toEqual([]);
    expect(readFile(markerFile)).toBeNull();
  });
});

describe('pending-accept markers: a restart', () => {
  it('a restart with an invite waiting yields a "cleared by a restart" notice with the invite\'s expiry, once', async () => {
    const { flow, inv, B, clock } = setup(60);
    await flow.receiveInvite(inv.message);
    clock.t = T0 + 10 * 60_000;

    // Restart: a fresh engine has nothing in memory; the marker becomes a notice.
    const after = bootRecipient(B.dir, B.deps, B.now);
    expect(after.flow.listPendingAccepts()).toEqual([]);
    expect(after.notices).toEqual([{ id: markerIdFor(inv.iid), claimedAgent: 'Scout', claimedOwner: 'Scout-owner', exp: inv.exp, clearedAt: new Date(clock.t).toISOString(), telegramNotified: false }]);
    expect(after.notices[0].exp).toBe(new Date(T0 + 60 * 60_000).toISOString());

    // Telegram: told once, in the operator's time zone, then never again.
    const sent: Array<{ topic: number; text: string }> = [];
    const mkTg = () => new PairingInviteTelegram({
      flow: after.flow, events: new EventEmitter(),
      send: async (topic, text) => { sent.push({ topic, text }); },
      answer: async () => {}, ownerUserId: () => 4242, chatId: () => '-100', operatorTopicId: () => 7, enforcing: () => true,
      now: () => clock.t,
      restartNotices: { list: () => after.markers.notices(), markNotified: (id) => after.markers.markTelegramNotified(id) },
      timeZone: (owner) => (owner === 4242 ? 'America/Los_Angeles' : undefined),
      schedule: () => {},
    });
    const tg = mkTg();
    // The constructor's own delivery is in flight; a concurrent one must not send it twice.
    expect(await tg.deliverRestartNotices()).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ topic: 7, text: 'An invite from "Scout" (it says it belongs to Scout-owner) was waiting and was cleared by a restart. Forward or paste it again before Tue, 2:00 PM PDT, about 50 min from now.' });
    // A second server start (or a second delivery) sends nothing more.
    mkTg();
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    // The dashboard still shows it.
    expect(after.markers.notices()).toHaveLength(1);
  });

  it('after expiry the marker is removed and NO notice appears (dashboard or Telegram)', async () => {
    const { flow, inv, B, clock, markerFile } = setup(30);
    await flow.receiveInvite(inv.message);
    clock.t = T0 + 31 * 60_000; // the server was down past the invite's expiry
    const after = bootRecipient(B.dir, B.deps, B.now);
    expect(after.notices).toEqual([]);
    expect(readFile(markerFile)).toBeNull();
    const sent: string[] = [];
    const tg = new PairingInviteTelegram({
      flow: after.flow, events: new EventEmitter(), send: async (_t, text) => { sent.push(text); },
      answer: async () => {}, ownerUserId: () => 4242, chatId: () => '-100', operatorTopicId: () => 7, enforcing: () => true,
      restartNotices: { list: () => after.markers.notices(), markNotified: (id) => after.markers.markTelegramNotified(id) },
      schedule: () => {},
    });
    expect(await tg.deliverRestartNotices()).toBe(0);
    expect(sent).toEqual([]);
  });

  it('a notice expires on the dashboard at the invite\'s expiry', async () => {
    const { flow, inv, B, clock, markerFile } = setup(30);
    await flow.receiveInvite(inv.message);
    const after = bootRecipient(B.dir, B.deps, B.now);
    expect(after.markers.notices()).toHaveLength(1);
    clock.t = T0 + 31 * 60_000;
    expect(after.markers.notices()).toEqual([]);
    after.flow.listPendingAccepts(); // any listing sweeps expired notices from disk
    expect(readFile(markerFile)).toBeNull();
  });

  it('pasting the same invite again replaces the notice with a pending marker', async () => {
    const { flow, inv, B } = setup();
    await flow.receiveInvite(inv.message);
    const after = bootRecipient(B.dir, B.deps, B.now);
    expect(after.notices).toHaveLength(1);
    expect(await after.flow.receiveInvite(inv.message)).toMatchObject({ ok: true });
    expect(after.markers.notices()).toEqual([]);
    expect(after.flow.listPendingAccepts().map((p) => p.iid)).toEqual([inv.iid]);
  });

  it('the operator can dismiss a notice; an unknown id is refused', async () => {
    const { flow, inv, B } = setup();
    await flow.receiveInvite(inv.message);
    const after = bootRecipient(B.dir, B.deps, B.now);
    expect(after.markers.dismiss('00'.repeat(32))).toBe(false);
    expect(after.markers.dismiss(markerIdFor(inv.iid))).toBe(true);
    expect(after.markers.notices()).toEqual([]);
  });

  it('a Telegram notice that cannot be sent yet is retried, and marked only once it is sent', async () => {
    const { flow, inv, B } = setup();
    await flow.receiveInvite(inv.message);
    const after = bootRecipient(B.dir, B.deps, B.now);
    let topic: number | undefined;
    const retries: Array<() => void> = [];
    const sent: string[] = [];
    const tg = new PairingInviteTelegram({
      flow: after.flow, events: new EventEmitter(), send: async (_t, text) => { sent.push(text); },
      answer: async () => {}, ownerUserId: () => 4242, chatId: () => '-100', operatorTopicId: () => topic, enforcing: () => true,
      restartNotices: { list: () => after.markers.notices(), markNotified: (id) => after.markers.markTelegramNotified(id) },
      schedule: (fn) => { retries.push(fn); },
    });
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([]);
    expect(after.markers.notices()[0].telegramNotified).toBe(false);
    expect(retries.length).toBeGreaterThan(0);
    topic = 7;
    expect(await tg.deliverRestartNotices()).toBe(1);
    expect(after.markers.notices()[0].telegramNotified).toBe(true);
  });

  it('a send that fails is not marked as sent, and is retried', async () => {
    const { flow, inv, B } = setup();
    await flow.receiveInvite(inv.message);
    const after = bootRecipient(B.dir, B.deps, B.now);
    let fail = true;
    const retries: Array<() => void> = [];
    const sent: string[] = [];
    const tg = new PairingInviteTelegram({
      flow: after.flow, events: new EventEmitter(),
      send: async (_t, text) => { if (fail) throw new Error('telegram down'); sent.push(text); },
      answer: async () => {}, ownerUserId: () => 4242, chatId: () => '-100', operatorTopicId: () => 7, enforcing: () => true,
      restartNotices: { list: () => after.markers.notices(), markNotified: (id) => after.markers.markTelegramNotified(id) },
      schedule: (fn) => { retries.push(fn); },
    });
    await new Promise((r) => setImmediate(r));
    expect(after.markers.notices()[0].telegramNotified).toBe(false);
    expect(retries.length).toBeGreaterThan(0);
    fail = false;
    expect(await tg.deliverRestartNotices()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(after.markers.notices()[0].telegramNotified).toBe(true);
  });

  it('a corrupt marker file is treated as empty and does not stop the engine', async () => {
    const { B, inv } = setup();
    fs.mkdirSync(path.join(B.dir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(B.dir, 'threadline', PENDING_ACCEPT_MARKERS_FILE), '{nope');
    const after = bootRecipient(B.dir, B.deps, B.now);
    expect(after.notices).toEqual([]);
    expect(await after.flow.receiveInvite(inv.message)).toMatchObject({ ok: true });
  });
});

describe('restart holds from the engine', () => {
  it('one hold per waiting invite, until its expiry; none once the accept is sent', async () => {
    const { flow, inv } = setup(45);
    expect(flow.restartHolds()).toEqual([]);
    await flow.receiveInvite(inv.message);
    const holds = flow.restartHolds();
    expect(holds).toHaveLength(1);
    expect(holds[0].until).toBe(T0 + 45 * 60_000);
    expect(holds[0].reason).toContain('"Scout"');
    flow.approveAccept(inv.iid);
    expect(flow.restartHolds()).toEqual([]);
  });

  it('no hold after the invite expires', async () => {
    const { flow, inv, clock } = setup(30);
    await flow.receiveInvite(inv.message);
    clock.t = T0 + 30 * 60_000 + 1;
    expect(flow.restartHolds()).toEqual([]);
  });
});

describe('restart notice text', () => {
  it('uses the operator\'s zone when known, else labelled UTC; an invalid zone falls back to UTC', () => {
    const exp = '2026-10-20T21:00:00.000Z';
    expect(formatExpiry(exp, 'America/Los_Angeles')).toBe('Tue, 2:00 PM PDT');
    expect(formatExpiry(exp)).toBe('Tue 21:00 UTC');
    expect(formatExpiry(exp, 'Not/AZone')).toBe('Tue 21:00 UTC');
    expect(restartNoticeText({ claimedAgent: 'Scout', claimedOwner: '', exp }, undefined, Date.parse(exp) - 3 * 3_600_000))
      .toBe('An invite from "Scout" was waiting and was cleared by a restart. Forward or paste it again before Tue 21:00 UTC, about 3 h from now.');
  });
});

/** The same invite with its expiry rewritten (checksum recomputed): what a hostile or broken inviter can send. */
function withExp(message: string, exp: string): string {
  const d = decodeInvite(findInviteToken(message)!);
  if (!d.ok) throw new Error('fixture invite did not decode');
  return encodeInvite({ ...d.invite, exp });
}

describe('an invite\'s expiry is checked on receipt (Echo\'s review)', () => {
  it('an invite expiring in 2099 is refused with the named reason: no pending accept, no marker, no hold', async () => {
    const { flow, inv, markerFile } = setup();
    const far = withExp(inv.message, '2099-01-01T00:00:00.000Z');
    expect(decodeInvite(findInviteToken(far)!).ok).toBe(true); // control: core itself accepts it
    const r = await flow.receiveInvite(`Fwd: ${far}`);
    expect(r).toEqual({ ok: false, reason: EXP_TOO_FAR_REASON });
    expect(EXP_TOO_FAR_REASON).toMatch(/longer than 24 hours/);
    expect(flow.listPendingAccepts()).toEqual([]);
    expect(readFile(markerFile)).toBeNull();
    expect(flow.restartHolds()).toEqual([]);
  });

  it('a valid 24 h invite still works, and its hold ends at its expiry', async () => {
    const { flow, inv } = setup(24 * 60);
    expect(await flow.receiveInvite(inv.message)).toMatchObject({ ok: true });
    expect(flow.restartHolds()[0].until).toBe(T0 + INVITE_MAX_TTL_MS);
  });

  it('clock skew: 24 h + 4 min ahead is accepted, 24 h + 6 min is refused', async () => {
    const a = setup();
    expect(await a.flow.receiveInvite(withExp(a.inv.message, new Date(T0 + INVITE_MAX_TTL_MS + 4 * 60_000).toISOString()))).toMatchObject({ ok: true });
    const b = setup();
    expect(await b.flow.receiveInvite(withExp(b.inv.message, new Date(T0 + INVITE_MAX_TTL_MS + 6 * 60_000).toISOString()))).toEqual({ ok: false, reason: EXP_TOO_FAR_REASON });
  });

  it('defence in depth: a far-future pending accept that got in anyway holds for at most 24 h from when it was first seen', async () => {
    const { flow, inv, clock } = setup();
    // Bypass the receipt check (as an older engine or a future code path might).
    const r = await PairingInviteFlow.prototype.receiveInvite.call(flow, withExp(inv.message, '2099-01-01T00:00:00.000Z'));
    expect(r.ok).toBe(true);
    expect(flow.restartHolds()[0].until).toBe(T0 + INVITE_MAX_TTL_MS);
    clock.t = T0 + 60 * 60_000; // later listings keep the first-seen clamp
    expect(flow.restartHolds()[0].until).toBe(T0 + INVITE_MAX_TTL_MS);
  });

  it('the clamp is from when the accept was recorded, also through the normal path', async () => {
    const { flow, inv, clock } = setup(24 * 60);
    clock.t = T0 + 10 * 60_000;
    expect(await flow.receiveInvite(inv.message)).toMatchObject({ ok: true });
    clock.t = T0 + 20 * 60_000;
    // exp (T0 + 24 h) is sooner than recordedAt + 24 h, so exp wins
    expect(flow.restartHolds()[0].until).toBe(T0 + INVITE_MAX_TTL_MS);
  });
});
