import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { NeverSilentStore } from '../../src/monitoring/neverSilent/NeverSilentStore.js';
import { NeverSilentWatcher, type NeverSilentDeps } from '../../src/monitoring/neverSilent/NeverSilentWatcher.js';
import type { ProfileRegisteredReplyProof } from '../../src/core/profileProposalResponseSettlement.js';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/neverSilent-registered-reply.test.ts' }); });
function fixture() {
  let now = 1000; const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-exact-')); roots.push(root);
  const store = new NeverSilentStore(root, () => now); const sent: string[] = []; const proofs = new WeakSet<object>();
  const deps: NeverSilentDeps = { store, now: () => now, verifyRegisteredReplyProof: p => !!p && typeof p === 'object' && proofs.has(p),
    config: () => ({ enabled: true, judge: false, actions: false, frameworkFallback: false, confidenceFloor: .8, noticeAfterMs: 10 }),
    judge: null, resolveSession: () => null, capturePane: () => null, authStatus: async () => null, accountFacts: () => null,
    healthyByFramework: () => ({}), sameEngineHealthy: () => false, fallbackEngine: () => null, hints: () => [], isPinned: () => false,
    isProtected: () => false, observeLoginExpired: async () => {}, swap: async () => ({ swapped: false }), applyFallback: async () => ({ ok: false, from: null, fromUpdatedBy: null }),
    restoreFallback: async () => false, sendNotice: async (_p, _k, text) => { sent.push(text); return '999'; }, repairStarted: () => false, accountHealthy: () => false };
  const watcher = new NeverSilentWatcher(deps);
  const proof = (id = '101'): ProfileRegisteredReplyProof => { const p = Object.freeze({ generation: 'g', attemptId: 'a'+id, requestId: 'r', source: '7', principal: 'telegram:1', inboundId: id, deliveredMessageId: 500 }); proofs.add(p); return p; };
  const accept = (id = '101') => store.accept({ platform: 'telegram', conversationKey: '7', inboundMessageId: id, text: 'question '+id, deadlineMs: 10 });
  const disk = () => JSON.parse(fs.readFileSync(path.join(root, 'state/never-silent.json'), 'utf8'));
  return { store, watcher, deps, proof, accept, disk, sent, later: () => { now += 100; } };
}
describe('exact registered reminder bookkeeping', () => {
  it('rolls failed ordinary release back before a later successful unrelated accept', () => {
    const h = fixture(); h.accept(); const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Error('disk'); });
    expect(() => h.store.release('telegram', '7', 'ended')).toThrow(); rename.mockRestore(); h.accept('102');
    expect(h.disk().obligations.map((o: any) => o.state)).toEqual(['pending', 'pending']);
  });
  it('retains real proof through failed acceptance and same-ID admission without inventing a row', async () => {
    const h = fixture(); vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Error('disk'); });
    expect(() => h.accept()).toThrow(); expect(h.watcher.onRegisteredReply(h.proof())).toBe('pending');
    expect(h.store.openFor('telegram', '7')).toHaveLength(0); h.accept(); h.accept('102'); h.later(); await h.watcher.tick();
    expect(h.disk().obligations.find((o: any) => o.inboundMessageId === '101').state).toBe('answered');
    expect(h.disk().obligations.find((o: any) => o.inboundMessageId === '102').state).not.toBe('answered');
    expect(h.sent).toHaveLength(1);
  });
  it('rejects copied or unknown proof without settling any obligation', () => {
    const h = fixture(); h.accept(); const p = h.proof(); expect(h.watcher.onRegisteredReply({ ...p })).toBe('unavailable');
    expect(h.store.openFor('telegram', '7')).toHaveLength(1); expect(h.watcher.onRegisteredReply(p)).toBe('recorded');
    expect(h.watcher.onRegisteredReply(p)).toBe('recorded');
  });
});

it.each(['write', 'rename'] as const)('restores failed ordinary reply and acceptance after %s failure', operation => {
  const h = fixture(); h.accept();
  const fail = () => { throw Error('storage failure'); };
  const spy = operation === 'write' ? vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(fail) : vi.spyOn(fs, 'renameSync').mockImplementationOnce(fail);
  expect(() => h.store.recordReply('telegram', '7')).toThrow(); spy.mockRestore(); h.accept('102');
  expect(h.disk().obligations.map((o: any) => o.state)).toEqual(['pending', 'pending']);
});

it('reconciles in one batch only after distinct ordinary commit progress, never its own writes', async () => {
  const h = fixture(); h.accept(); const originalRename = fs.renameSync.bind(fs); let remaining = 2; let reconciliationAttempts = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    const data = JSON.parse(fs.readFileSync(from, 'utf8'));
    if (data.obligations.some((o: any) => o.registeredReply)) {
      reconciliationAttempts++; if (remaining-- > 0) throw Error('settlement storage failure');
    }
    originalRename(from, to);
  });
  const p = h.proof(); expect(h.watcher.onRegisteredReply(p)).toBe('pending');
  await h.watcher.tick(); await h.watcher.tick(); expect(reconciliationAttempts).toBe(1);
  h.store.accept({ platform: 'telegram', conversationKey: '8', inboundMessageId: '201', text: 'neighbor', deadlineMs: 100000 });
  await h.watcher.tick(); expect(reconciliationAttempts).toBe(2);
  await h.watcher.tick(); expect(reconciliationAttempts).toBe(2);
  h.store.accept({ platform: 'telegram', conversationKey: '8', inboundMessageId: '202', text: 'other neighbor', deadlineMs: 100000 });
  const credit = h.store.getOrdinaryCommitRevision(); await h.watcher.tick();
  expect(reconciliationAttempts).toBe(3); expect(h.store.getOrdinaryCommitRevision()).toBe(credit);
  expect(h.watcher.onRegisteredReply(p)).toBe('recorded'); expect(reconciliationAttempts).toBe(3);
  expect(h.disk().obligations.find((o: any) => o.inboundMessageId === '101').state).toBe('answered');
});

it('does not spin reconciliation writes under permanent failure and lets the event loop progress', async () => {
  const h = fixture(); h.accept(); let calls = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { calls++; throw Error('permanent failure'); });
  expect(h.watcher.onRegisteredReply(h.proof())).toBe('pending'); h.later();
  for (let i = 0; i < 8; i++) await h.watcher.tick();
  await new Promise<void>(done => setImmediate(done));
  expect(calls).toBe(1); expect(h.sent).toEqual([]); expect(h.store.openFor('telegram', '7')).toHaveLength(1);
});

it('completes rollback before the next-turn neighbor commit', async () => {
  const h = fixture(); h.accept(); const rename = fs.renameSync.bind(fs); let queued!: Promise<void>;
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    queued = new Promise<void>(done => setImmediate(() => { h.accept('102'); done(); }));
    throw Error('failed release');
  }).mockImplementation(rename);
  expect(() => h.store.release('telegram', '7', 'ended')).toThrow(); await queued;
  expect(h.disk().obligations.map((o: any) => o.state)).toEqual(['pending', 'pending']);
});

it.each(['durable', 'failed-persistence', 'incident-action'] as const)('fences a paused judge against %s changes', async mode => {
  const h = fixture(); h.accept(); h.later();
  let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
  let release!: () => void; const paused = new Promise<void>(done => { release = done; });
  h.deps.config = () => ({ enabled: true, judge: true, actions: true, frameworkFallback: true, confidenceFloor: .8, noticeAfterMs: 10 });
  h.deps.resolveSession = () => ({ tmuxSession: 's', framework: 'claude-code', accountId: null, configHome: null, alive: true, startedAt: 0 });
  h.deps.judge = { judge: async () => { entered(); await paused; return { silenceClass: 'undetermined', confidence: 0, route: 'test', evidence: '', truncated: false, actionsSinceMessage: 'unknown', calls: 1 }; } } as any;
  const tick = h.watcher.tick(); await started;
  if (mode === 'incident-action') {
    const incident = h.store.openIncident('telegram', '7')!;
    h.store.updateIncident(incident.id, { action: 'external-action', outcome: 'changed' });
  } else {
    if (mode === 'failed-persistence') vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Error('settlement failed'); });
    expect(h.watcher.onRegisteredReply(h.proof())).toBe(mode === 'durable' ? 'recorded' : 'pending');
  }
  release(); await tick; expect(h.sent).toEqual([]);
  if (mode !== 'incident-action') {
    h.accept('102'); h.later(); h.deps.config = () => ({ enabled: true, judge: false, actions: false, frameworkFallback: false, confidenceFloor: .8, noticeAfterMs: 10 });
    await h.watcher.tick(); expect(h.sent).toHaveLength(1);
    expect(h.store.openFor('telegram', '7').some(o => o.inboundMessageId === '102')).toBe(true);
  }
});


it('batches retained proofs into one progress-funded write and rolls the entire batch back on failure', async () => {
  const h = fixture(); h.accept(); h.accept('102');
  const rename = fs.renameSync.bind(fs); let failures = 3; let writes = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    const rows = JSON.parse(fs.readFileSync(from, 'utf8')).obligations;
    if (rows.some((o: any) => o.registeredReply)) { writes++; if (failures-- > 0) throw Error('bookkeeping failure'); }
    rename(from, to);
  });
  const p = h.proof(), q = h.proof('102');
  expect(h.watcher.onRegisteredReply(p)).toBe('pending'); expect(h.watcher.onRegisteredReply(q)).toBe('pending');
  const progress = (id: string) => h.store.accept({ platform: 'telegram', conversationKey: '8', inboundMessageId: id, text: 'still owed', deadlineMs: 100000 });
  progress('201'); await h.watcher.tick(); expect(writes).toBe(3);
  expect(h.disk().obligations.filter((o: any) => o.conversationKey === '7').map((o: any) => o.state)).toEqual(['pending', 'pending']);
  await h.watcher.tick(); expect(writes).toBe(3);
  progress('202'); await h.watcher.tick(); expect(writes).toBe(4);
  expect(h.disk().obligations.filter((o: any) => o.conversationKey === '7').map((o: any) => o.state)).toEqual(['answered', 'answered']);
});

it('keeps disabled, terminal, and missing obligations distinct without minting any neighbor', () => {
  const h = fixture(); h.accept(); h.store.release('telegram', '7', 'owner-ended');
  expect(h.watcher.onRegisteredReply(h.proof())).toBe('not-required');
  h.deps.config = () => ({ enabled: false } as any);
  expect(h.watcher.onRegisteredReply(h.proof('102'))).toBe('not-required');
  expect(h.store.openFor('telegram', '7')).toEqual([]);
});

it.each(['fallback', 'swap', 'waiting-notice', 'status-notice'] as const)('records an admitted %s outcome despite new neighbor and exact settlement, without admitting a stale next effect', async effect => {
  const h = fixture(); h.accept(); h.later();
  let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
  let release!: () => void; const paused = new Promise<void>(done => { release = done; });
  h.deps.config = () => ({ enabled: true, judge: true, actions: effect === 'fallback' || effect === 'swap', frameworkFallback: true, confidenceFloor: .8, noticeAfterMs: 10 });
  h.deps.resolveSession = () => ({ tmuxSession: 'actual-session', framework: 'claude-code', accountId: null, configHome: null, alive: true, startedAt: 0 });
  h.deps.fallbackEngine = () => 'codex-cli'; h.deps.sameEngineHealthy = () => effect === 'swap';
  h.deps.judge = { judge: async () => ({ silenceClass: effect === 'waiting-notice' ? 'undetermined' : 'engine-login', confidence: 1, route: 'test', evidence: '', truncated: false, actionsSinceMessage: 'none', calls: 1 }) } as any;
  h.deps.applyFallback = async () => { entered(); await paused; return { ok: true, from: 'claude-code', fromUpdatedBy: 'system:original' }; };
  h.deps.swap = async () => { entered(); await paused; return { swapped: true }; };
  h.deps.sendNotice = async (_p, _k, text) => { h.sent.push(text); entered(); await paused; return '901'; };
  const tick = h.watcher.tick(); await started;
  h.accept('102'); expect(h.watcher.onRegisteredReply(h.proof())).toBe('recorded');
  const currentIncident = h.store.openIncident('telegram', '7')!;
  h.store.updateIncident(currentIncident.id, { attempts: 3, triedFrameworks: ['gemini-cli'] });
  release(); await tick;
  const data = h.disk(), incident = data.incidents[0];
  if (effect === 'fallback') {
    expect(incident.fallback).toMatchObject({ from: 'claude-code', fromUpdatedBy: 'system:original', to: 'codex-cli' });
    expect(incident.triedFrameworks).toEqual(expect.arrayContaining(['claude-code', 'gemini-cli'])); expect(incident.action).toBe('fallback'); expect(incident.outcome).toBe('succeeded'); expect(h.sent).toEqual([]);
  } else if (effect === 'swap') {
    expect(incident.attempts).toBe(4); expect(incident.action).toBe('swap'); expect(incident.outcome).toBe('succeeded'); expect(h.sent).toEqual([]);
  } else {
    expect(incident.notices).toHaveLength(1); expect(incident.notices[0]).toMatchObject({ messageId: '901', covered: ['telegram:7:101'] });
    expect(data.obligations.find((o: any) => o.inboundMessageId === '101').coveredBy).toContain(effect === 'waiting-notice' ? 'waiting' : 'status');
    expect(h.sent).toHaveLength(1);
  }
  const neighbor = data.obligations.find((o: any) => o.inboundMessageId === '102');
  expect(neighbor.state).toBe('pending'); expect(neighbor.coveredBy).toEqual([]); expect(neighbor.redrivenAt).toBeUndefined();
});
