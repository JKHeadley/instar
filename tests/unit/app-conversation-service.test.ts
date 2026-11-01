/**
 * AppConversationService (docs/specs/mobile-native-conversations.md §4.1/§4.2/§4.8): boot
 * recovery of interrupted requests, create recovery returning the SAME conversation, bind-app on
 * lease acquisition and unbind-app on loss, alias re-derivation from the store, and replicated
 * events landing with a local alias.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { MobileChatRequestStore } from '../../src/core/MobileChatRequests.js';
import { derivedEventId } from '../../src/core/appConversationText.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-conversation-service.test.ts' }); });
const KEY = '7a1c8a3e-1b2c-4d5e-9f90-1234567890ab';
const DEV = 'dev-00000001';

function boot(dir: string, opts: { lease?: { held: boolean }; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const lease = opts.lease ?? { held: true };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1' });
  const requests = new MobileChatRequestStore(dir, now);
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests, holdsLease: () => lease.held,
    ownerName: () => 'Justin', dispatch: () => null, now,
  });
  return { svc, registry, requests, lease };
}
const rid = (t: number) => `${t}-${'0b3c8a3e-1b2c-4d5e-8f90-1234567890ab'}`;

describe('AppConversationService', () => {
  it('recovers an interrupted create as the SAME conversation (reservation names the key)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appsvc-')); dirs.push(dir);
    let t = Date.now();
    const a = boot(dir, { now: () => t });
    const id = rid(t);
    // Crash after the reservation and the alias mint, before the store event and done.
    expect(a.requests.reserve(DEV, id, 'h', 0, { op: 'create', conversationKey: KEY, title: 'Trip' }).kind).toBe('reserved');
    a.registry.mintAppAlias(KEY);
    await a.registry.close();
    t += 6 * 60_000; // past the 5-minute stranded threshold
    const b = boot(dir, { now: () => t });
    const rec = b.requests.get(DEV, id)!;
    expect(rec.state).toBe('done');
    expect(rec.result!.body).toEqual({ conversationKey: KEY, title: 'Trip' });
    expect(b.svc.store.listConversations().conversations.map((c) => c.conversationKey)).toEqual([KEY]);
    // A second recovery pass changes nothing (same event id merges away).
    b.svc.recoverStranded();
    expect(b.svc.store.syncEvents(KEY, null, 100).events).toHaveLength(1);
  });

  it('recovers a send: missing message → not-delivered; message without delivery → unknown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appsvc-')); dirs.push(dir);
    let t = Date.now();
    const a = boot(dir, { now: () => t });
    a.svc.applyCreate(DEV, rid(t - 1), KEY, 'Trip');
    const r1 = rid(t + 1); const r2 = rid(t + 2);
    const m2 = derivedEventId('msg', `${DEV}\u0000${r2}`);
    a.requests.reserve(DEV, r1, 'h1', 0, { op: 'send', conversationKey: KEY, messageId: derivedEventId('msg', `${DEV}\u0000${r1}`) });
    a.requests.reserve(DEV, r2, 'h2', 0, { op: 'send', conversationKey: KEY, messageId: m2 });
    a.svc.store.append({ eventId: 'op-2', kind: 'message', conversationKey: KEY, messageId: m2, role: 'operator', text: 'hi', at: new Date(t).toISOString(), machineId: 'm1' });
    await a.registry.close();
    t += 6 * 60_000;
    const b = boot(dir, { now: () => t });
    expect(b.requests.lookup(DEV, r1, 'h1')).toEqual({ kind: 'done', status: 409, body: expect.objectContaining({ error: 'not-delivered' }) });
    expect(b.requests.lookup(DEV, r2, 'h2')).toEqual({ kind: 'outcome-unknown' });
    expect(b.svc.store.deliveryState(m2)).toBe('unknown');
  });

  it('binds every live conversation on lease acquisition and unbinds on loss', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appsvc-')); dirs.push(dir);
    const lease = { held: false };
    const { svc, registry } = boot(dir, { lease });
    svc.applyCreate(DEV, rid(Date.now()), KEY, 'Trip');
    const alias = registry.appAliasFor(KEY)!;
    expect(svc.ownsAlias(alias)).toBe(false);
    lease.held = true; svc.leaseTick();
    expect(registry.isAppBound(alias)).toBe(true);
    expect(svc.ownsAlias(alias)).toBe(true);
    lease.held = false; svc.leaseTick();
    expect(registry.isAppBound(alias)).toBe(false);
  });

  it('a conversation created on another machine gets a local alias (and binding on the owner) when it replicates in', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appsvc-')); dirs.push(dir);
    const { svc, registry } = boot(dir);
    const added = svc.ingestReplicated([
      { eventId: 'cr-peer', kind: 'created', conversationKey: KEY, title: 'From peer', at: new Date().toISOString(), machineId: 'm2' },
      null,
    ]);
    expect(added).toBe(1);
    const alias = registry.appAliasFor(KEY)!;
    expect(alias).toBeLessThan(0);
    expect(registry.isAppBound(alias)).toBe(true);
    expect(svc.ingestReplicated([{ eventId: 'cr-peer', kind: 'created', conversationKey: KEY, title: 'From peer', at: new Date().toISOString(), machineId: 'm2' }])).toBe(0);
  });

  it('re-derives aliases from the store at boot when the registry lost them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appsvc-')); dirs.push(dir);
    const a = boot(dir);
    a.svc.applyCreate(DEV, rid(Date.now()), KEY, 'Trip');
    await a.registry.close();
    for (const f of ['conversation-registry.jsonl', path.join('state', 'conversation-registry.json')]) {
      SafeFsExecutor.safeRmSync(path.join(dir, f), { force: true, operation: 'tests/unit/app-conversation-service.test.ts' });
    }
    const b = boot(dir);
    expect(b.registry.appAliasFor(KEY)).not.toBeNull();
  });
});

describe('production wiring (src/commands/server.ts)', () => {
  it('the bootstrap-wired service carries the Telegram path\'s stop side effects, the relay check and replication', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'server.ts'), 'utf8');
    const start = src.indexOf('const appSvc = new AppConversationService({');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, start + 6000);
    for (const needle of ['onEmergencyStop', "resumeQueue?.pause('message-sentinel emergency stop')", 'stopAutonomousTopic(', 'recordOperatorStop(alias)', 'relayReady:', 'setReplicationHook(', 'spawnAdmission: () => _spawnAdmission']) {
      expect(block).toContain(needle);
    }
    // Built OUTSIDE the Slack-configured block, so an agent with no Slack has it.
    expect(src.indexOf('const appSvc = new AppConversationService({')).toBeLessThan(src.indexOf('const slackInboundDispatch = async ('));
  });
});
