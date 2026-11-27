/**
 * SEC-153: the dispatch channel was unsigned. A polled dispatch could run actions, change
 * configuration, and hand its text to a new session as the prompt. Now only a dispatch signed by a
 * pinned key is auto-applied or executed, remote prose never becomes a session prompt, the channel's
 * origin is not writable with the API key, and the old address is migrated off. Everything held stays
 * in the dispatch record, pending review (loss-free).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DispatchManager, type Dispatch } from '../../src/core/DispatchManager.js';
import { AutoDispatcher } from '../../src/core/AutoDispatcher.js';
import { DispatchExecutor } from '../../src/core/DispatchExecutor.js';
import { DispatchVerifier } from '../../src/core/DispatchVerifier.js';
import { migrateConfigLegacyDispatchUrl, LEGACY_DISPATCH_URLS } from '../../src/core/PostUpdateMigrator.js';
import { bearerConfigWriteRefusal, DISPATCH_ORIGIN_KEYS } from '../../src/config/bearerConfigWrite.js';
import { PATCHABLE_CONFIG_KEYS, OPERATOR_ONLY_SESSION_KEYS } from '../../src/server/routes.js';
import type { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const keys = crypto.generateKeyPairSync('ed25519');
const PUB = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function sign(d: Omit<Dispatch, 'receivedAt' | 'applied'>): Record<string, unknown> {
  const signedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const payload = JSON.stringify({ content: d.content, dispatchId: d.dispatchId, expiresAt, priority: d.priority, signedAt, title: d.title, type: d.type });
  return { ...d, signedAt, expiresAt, keyId: 'k1', signature: crypto.sign(null, Buffer.from(payload), keys.privateKey).toString('base64') };
}

const STRUCTURED = JSON.stringify({ description: 'x', steps: [{ type: 'config_merge', file: '.instar/config.json', merge: { a: 1 } }] });
const base = (id: string, type: Dispatch['type'], content: string) => ({ dispatchId: id, type, title: `T ${id}`, content, priority: 'normal' as const, createdAt: '2026-11-21T00:00:00Z' });

let dir: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec153-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  // An earlier poll happened, unless a case removes it (a first poll only records history).
  fs.writeFileSync(path.join(dir, 'state', 'dispatches-last-check.json'), JSON.stringify({ lastCheck: '2026-01-01T00:00:00.000Z' }));
});
afterEach(() => {
  fetchSpy?.mockRestore();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/sec153-dispatch-origin.test.ts' });
});

function serve(rows: Array<Record<string, unknown>>): void {
  fetchSpy?.mockRestore();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ dispatches: rows, count: rows.length }), { status: 200 }));
}

function rig(opts: { gate?: boolean; autoApply?: boolean } = {}) {
  const manager = new DispatchManager({ enabled: true, dispatchUrl: 'https://example.com/d', dispatchFile: path.join(dir, 'state', 'dispatches.json'), autoApply: opts.autoApply ?? false });
  const executor = new DispatchExecutor(dir, null);
  const execute = vi.spyOn(executor, 'execute').mockResolvedValue({ success: true, message: 'ok', stepResults: [], completedSteps: 1, totalSteps: 1, rolledBack: false } as never);
  const state = { get: vi.fn(), set: vi.fn() } as unknown as StateManager;
  const ad = new AutoDispatcher(manager, executor, state, dir, { autoApplyPassive: opts.autoApply ?? false, autoExecuteActions: true }, null);
  if (opts.gate) ad.setSignatureGate(new DispatchVerifier({ trustedKeys: { k1: PUB }, required: true }));
  const tick = () => (ad as unknown as { tick: () => Promise<void> }).tick();
  return { manager, execute, tick };
}

describe('SEC-153: only signed dispatches act', () => {
  it('an unsigned configuration or action dispatch is never executed: it waits for review', async () => {
    serve([base('c1', 'configuration', STRUCTURED), base('a1', 'action', STRUCTURED)]);
    const r = rig({ gate: true });
    await r.tick();
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.manager.get('c1')!.pendingApproval).toBe(true);
    expect(r.manager.get('a1')!.pendingApproval).toBe(true);
    expect(r.manager.get('c1')!.applied).toBe(false);
  });

  it('with no pinned keys at all, even a signed dispatch is held', async () => {
    serve([sign(base('c2', 'configuration', STRUCTURED))]);
    const r = rig({ gate: false });
    await r.tick();
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.manager.get('c2')!.pendingApproval).toBe(true);
  });

  it('a structured dispatch signed by a pinned key runs, and the record says it verified', async () => {
    serve([sign(base('c3', 'configuration', STRUCTURED))]);
    const r = rig({ gate: true });
    await r.tick();
    expect(r.execute).toHaveBeenCalledTimes(1);
    expect(r.manager.get('c3')!.signature).toBeTruthy();
    expect(r.manager.get('c3')!.signatureVerified).toBe(true);
  });

  it('a signature over other text, or by an unknown key, is held', async () => {
    const tampered = { ...sign(base('c4', 'configuration', STRUCTURED)), content: JSON.stringify({ steps: [{ type: 'shell', command: 'true' }] }) };
    const otherKey = { ...sign(base('c5', 'configuration', STRUCTURED)), keyId: 'k9' };
    serve([tampered, otherKey]);
    const r = rig({ gate: true });
    await r.tick();
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.manager.get('c4')!.pendingApproval).toBe(true);
    expect(r.manager.get('c5')!.pendingApproval).toBe(true);
  });
});

describe('SEC-153: remote prose never becomes a session prompt', () => {
  it('a prose dispatch, even signed, is held instead of starting a session', async () => {
    serve([sign(base('p1', 'configuration', 'Please edit your config and run this.')), sign(base('p2', 'action', 'Do something on the machine.'))]);
    const r = rig({ gate: true });
    await r.tick();
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.manager.get('p1')!.pendingApproval).toBe(true);
    expect(r.manager.get('p2')!.pendingApproval).toBe(true);
  });

  it('a signed structured action with an agentic step is held', async () => {
    serve([sign(base('p3', 'action', JSON.stringify({ description: 'x', steps: [{ type: 'agentic', prompt: 'remote words' }] })))]);
    const r = rig({ gate: true });
    await r.tick();
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.manager.get('p3')!.pendingApproval).toBe(true);
  });

  it('an unsigned lesson is not auto-applied, so its text stays out of the session context file', async () => {
    serve([base('l1', 'lesson', 'Remote advice.')]);
    const r = rig({ gate: true, autoApply: true });
    await r.tick();
    expect(r.manager.get('l1')!.applied).toBe(false);
    expect(fs.existsSync(path.join(dir, 'state', 'dispatch-context.md'))).toBe(false);
  });

  it('a signed lesson is auto-applied and reaches the context file', async () => {
    serve([sign(base('l2', 'lesson', 'Signed advice.'))]);
    const r = rig({ gate: true, autoApply: true });
    await r.tick();
    expect(r.manager.get('l2')!.applied).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'state', 'dispatch-context.md'), 'utf-8')).toContain('Signed advice.');
  });

  it('the routes give sessions a cleaned, bounded title for an unsigned dispatch (wiring)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/server/routes.ts'), 'utf-8');
    expect(src).toContain('title: cleanDispatchTitle(d.title), contentWithheld: true');
  });

  it('the context file never carries configuration or action text, nor an unsigned automatic apply from before', () => {
    const file = path.join(dir, 'state', 'dispatches.json');
    const row = (id: string, type: Dispatch['type'], auto: boolean, extra: Partial<Dispatch> = {}): Dispatch => ({ ...base(id, type, `text ${id}`), receivedAt: 'x', applied: true, evaluation: { decision: 'accepted', reason: 'r', evaluatedAt: 'x', auto }, ...extra });
    fs.writeFileSync(file, JSON.stringify([row('k1', 'configuration', false), row('k2', 'action', false), row('k3', 'lesson', true), row('k4', 'lesson', false), row('k5', 'strategy', true, { signatureVerified: true })]));
    const m = new DispatchManager({ enabled: false, dispatchUrl: '', dispatchFile: file });
    m.applyToContext('k4');
    const text = fs.readFileSync(path.join(dir, 'state', 'dispatch-context.md'), 'utf-8');
    expect(text).toContain('text k4');
    expect(text).toContain('text k5');
    expect(text).not.toContain('text k1');
    expect(text).not.toContain('text k2');
    expect(text).not.toContain('text k3');
    // Loss-free: every record is still there.
    expect(m.list()).toHaveLength(5);
  });
});

describe('SEC-153: a fresh or rebuilt install does not replay history', () => {
  it('the first poll records every existing dispatch as history: none runs, none is applied, none is announced', async () => {
    SafeFsExecutor.safeUnlinkSync(path.join(dir, 'state', 'dispatches-last-check.json'), { operation: 'tests/unit/sec153-dispatch-origin.test.ts: fresh install' });
    serve([sign(base('h1', 'configuration', STRUCTURED)), base('h2', 'action', 'Prose from April.'), sign(base('h3', 'lesson', 'Old advice.'))]);
    const r = rig({ gate: true, autoApply: true });
    await r.tick();
    expect(r.execute).not.toHaveBeenCalled();
    for (const id of ['h1', 'h2', 'h3']) {
      const d = r.manager.get(id)!;
      expect(d.historical).toBe(true);
      expect(d.applied).toBe(false);
      expect(d.pendingApproval).toBeFalsy();
    }
    expect(fs.existsSync(path.join(dir, 'state', 'dispatch-context.md'))).toBe(false);
    // The next poll acts only on what is new, and the history is not replayed.
    serve([sign(base('h1', 'configuration', STRUCTURED)), sign(base('n1', 'configuration', STRUCTURED))]);
    await r.tick();
    expect(r.execute).toHaveBeenCalledTimes(1);
    expect(r.manager.get('n1')!.historical).toBeUndefined();
  });

  it('nothing is recorded as applied when a session would have started: prose and agentic steps never reach the executor', async () => {
    serve([base('s1', 'configuration', 'Do this.'), sign(base('s2', 'action', JSON.stringify({ steps: [{ type: 'agentic', prompt: 'x' }] })))]);
    const r = rig({ gate: true });
    await r.tick();
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.manager.get('s1')!.applied).toBe(false);
    expect(r.manager.get('s2')!.applied).toBe(false);
  });

  it('at start, the session context file drops text it may no longer carry', () => {
    const file = path.join(dir, 'state', 'dispatches.json');
    const ctxFile = path.join(dir, 'state', 'dispatch-context.md');
    fs.writeFileSync(file, JSON.stringify([{ ...base('i1', 'configuration', 'install @example/pkg'), receivedAt: 'x', applied: true, evaluation: { decision: 'accepted', reason: 'r', evaluatedAt: 'x', auto: false } }]));
    fs.writeFileSync(ctxFile, '# Intelligence Dispatches (Applied)\n\ninstall @example/pkg\n');
    new DispatchManager({ enabled: false, dispatchUrl: '', dispatchFile: file });
    expect(fs.existsSync(ctxFile)).toBe(false);
  });
});

describe('SEC-153: the channel origin is not writable with the API key', () => {
  const opts = { fileConfig: {}, patchableKeys: PATCHABLE_CONFIG_KEYS, operatorOnlySessionKeys: OPERATOR_ONLY_SESSION_KEYS };
  it('the address, the record file and the pinned keys are refused; the on/off switch is not', () => {
    for (const k of DISPATCH_ORIGIN_KEYS) {
      expect(bearerConfigWriteRefusal(`dispatches.${k}`, 'x', opts), k).not.toBeNull();
      expect(bearerConfigWriteRefusal('dispatches', { [k]: 'x' }, opts), k).not.toBeNull();
    }
    expect(bearerConfigWriteRefusal('dispatches.enabled', false, opts)).toBeNull();
  });
  it('PATCH /config fences the same keys (wiring)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/server/routes.ts'), 'utf-8');
    expect(src).toContain("'dispatches' in patch");
    expect(src).toContain('DISPATCH_ORIGIN_KEYS.filter');
  });
});

describe('SEC-153: the old address is migrated off', () => {
  it('turns polling off for exactly the old address, keeps a note, and is idempotent', () => {
    const cfg: Record<string, unknown> = { dispatches: { enabled: true, dispatchUrl: LEGACY_DISPATCH_URLS[0], dispatchFile: '/x/dispatches.json', autoApply: false } };
    expect(migrateConfigLegacyDispatchUrl(cfg)).toBe(LEGACY_DISPATCH_URLS[0]);
    const d = cfg.dispatches as Record<string, unknown>;
    expect(d.enabled).toBe(false);
    expect(d.dispatchUrl).toBe('');
    expect(d.dispatchFile).toBe('/x/dispatches.json');
    expect((d.legacyDispatchUrlRemoved as Record<string, unknown>).url).toBe(LEGACY_DISPATCH_URLS[0]);
    expect(migrateConfigLegacyDispatchUrl(cfg)).toBeNull();
  });
  it('never touches an operator\'s own dispatch server, or an agent with no dispatch block', () => {
    const own: Record<string, unknown> = { dispatches: { enabled: true, dispatchUrl: 'https://mine.example/d', dispatchFile: 'f' } };
    expect(migrateConfigLegacyDispatchUrl(own)).toBeNull();
    expect((own.dispatches as Record<string, unknown>).enabled).toBe(true);
    expect(migrateConfigLegacyDispatchUrl({})).toBeNull();
  });
  it('a new agent is created with no dispatch server', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/commands/init.ts'), 'utf-8');
    expect(src).not.toContain('dawn.bot-me.ai/api/instar/dispatches');
  });
});
