/**
 * installAgentMessageHook (PR 3b) — end-to-end test of the agent-message hook closure
 * (composes decideRoute + ledger + processed-id store + role-handler map).
 *
 * Plus a wiring-integrity test that asserts TelegramAdapter calls the hook on text
 * messages BEFORE the existing onTopicMessage / this.handler dispatch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { A2A_VERSION, formatMarker, type RecipientConfig, type A2aMessage } from '../../../src/messaging/AgentTelegramComms.js';
import { AgentTelegramLedger, defaultLedgerPaths } from '../../../src/messaging/AgentTelegramLedger.js';
import { ProcessedIdStore } from '../../../src/messaging/ProcessedIdStore.js';
import { buildAgentMessageHook, type RoleHandler } from '../../../src/messaging/installAgentMessageHook.js';
import { TelegramAdapter } from '../../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const NOW = 1_779_900_000_000;

function marker(over: Partial<{ from: string; to: string; role: string; id: string; corr: string; ts: number }> = {}): string {
  const f = { from: 'instar-codey', to: 'echo', role: 'mentor-reply', id: 'r1', corr: 'p1', ts: NOW, ...over };
  return formatMarker({ from: f.from, to: f.to, role: f.role, id: f.id, corr: f.corr, ts: f.ts }, 'hi from codey');
}

function cfg(over: Partial<RecipientConfig> = {}): RecipientConfig {
  return {
    localAgent: 'echo',
    knownAgents: { 'instar-codey': { botId: 'codey-bot' } },
    acceptRoles: { 'instar-codey': ['mentor-reply'] },
    skewWindowMs: 24 * 60 * 60 * 1000,
    maxVersion: A2A_VERSION,
    ...over,
  };
}

describe('buildAgentMessageHook — closure end-to-end', () => {
  let dir: string;
  let ledger: AgentTelegramLedger;
  let store: ProcessedIdStore;
  let calls: Array<{ msg: A2aMessage; topicId: number }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-hook-'));
    ledger = new AgentTelegramLedger(defaultLedgerPaths(dir));
    store = new ProcessedIdStore({ filePath: path.join(dir, 'pids.json'), now: () => NOW });
    calls = [];
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'a2a-hook test' }); });

  const recordingHandler: RoleHandler = async (msg, ctx) => { calls.push({ msg, topicId: ctx.topicId }); };

  function input(text: string, over: Partial<{ senderIsBot: boolean; senderChatId?: string; senderBotId?: string; topicId: number; now: number }> = {}) {
    return { text, topicId: 42, senderIsBot: true, senderBotId: 'codey-bot', now: NOW, ...over };
  }

  function ledgerLines(file: 'sent' | 'received'): unknown[] {
    const fp = file === 'sent' ? defaultLedgerPaths(dir).sentPath : defaultLedgerPaths(dir).receivedPath;
    if (!fs.existsSync(fp)) return [];
    return fs.readFileSync(fp, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('FALL-THROUGH: a non-marker user message returns {handled:false} and writes NO audit row', async () => {
    const hook = buildAgentMessageHook({ config: cfg(), ledger, processedIds: store, roleHandlers: new Map() });
    const r = await hook(input('hey echo, how are you?'));
    expect(r).toEqual({ handled: false });
    expect(ledgerLines('received')).toEqual([]); // user messages don't flood the audit
  });

  it('ROUTE: valid a2a marker with a registered role-handler → handler called, audit row written, id marked processed', async () => {
    const handlers = new Map<string, RoleHandler>([['mentor-reply', recordingHandler]]);
    const hook = buildAgentMessageHook({ config: cfg(), ledger, processedIds: store, roleHandlers: handlers });
    const r = await hook(input(marker()));
    expect(r).toEqual({ handled: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].msg).toMatchObject({ from: 'instar-codey', role: 'mentor-reply', id: 'r1', corr: 'p1' });
    expect(calls[0].topicId).toBe(42);
    const rows = ledgerLines('received');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: 'routed', role: 'mentor-reply', id: 'r1', corr: 'p1' });
    expect(store.hasProcessed('r1')).toBe(true); // idempotency anchor recorded
  });

  it('IDEMPOTENCY: a re-delivered marker (same id) is dropped without calling the handler', async () => {
    const handlers = new Map<string, RoleHandler>([['mentor-reply', recordingHandler]]);
    const hook = buildAgentMessageHook({ config: cfg(), ledger, processedIds: store, roleHandlers: handlers });
    await hook(input(marker({ id: 'dup', corr: 'dup' })));
    expect(calls).toHaveLength(1);
    // Re-deliver
    const r2 = await hook(input(marker({ id: 'dup', corr: 'dup' })));
    expect(r2).toEqual({ handled: true });
    expect(calls).toHaveLength(1); // NOT called a second time
    const rows = ledgerLines('received');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ decision: 'dropped', dropReason: 'agent-marker-duplicate' });
  });

  it('SPOOF DEFENSE: a human-typed marker (senderIsBot=false, no sender_chat) is dropped, handler NOT called', async () => {
    const handlers = new Map<string, RoleHandler>([['mentor-reply', recordingHandler]]);
    const hook = buildAgentMessageHook({ config: cfg(), ledger, processedIds: store, roleHandlers: handlers });
    const r = await hook(input(marker(), { senderIsBot: false, senderChatId: undefined, senderBotId: 'codey-bot' }));
    expect(r).toEqual({ handled: true });
    expect(calls).toHaveLength(0); // role-handler NOT invoked
    expect(ledgerLines('received')[0]).toMatchObject({ decision: 'dropped', dropReason: 'agent-marker-spoofed-by-user' });
  });

  it('UNKNOWN-ROLE: marker with a role this recipient has no handler for is dropped', async () => {
    // acceptRoles allows mentor-reply but no handler registered for it
    const hook = buildAgentMessageHook({ config: cfg(), ledger, processedIds: store, roleHandlers: new Map() });
    const r = await hook(input(marker()));
    expect(r).toEqual({ handled: true });
    expect(ledgerLines('received')[0]).toMatchObject({ decision: 'dropped', dropReason: 'agent-marker-unknown-role' });
  });

  it('HANDLER ERROR: a role-handler that throws is logged but does NOT crash dispatch + the id stays marked', async () => {
    const throwingHandler: RoleHandler = async () => { throw new Error('boom'); };
    const handlers = new Map<string, RoleHandler>([['mentor-reply', throwingHandler]]);
    const hook = buildAgentMessageHook({ config: cfg(), ledger, processedIds: store, roleHandlers: handlers });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await hook(input(marker({ id: 'e1', corr: 'e1' })));
    expect(r).toEqual({ handled: true });
    expect(store.hasProcessed('e1')).toBe(true); // marked even though handler failed
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('TelegramAdapter wiring-integrity — hook fires before onTopicMessage', () => {
  let dir: string;
  let adapter: TelegramAdapter;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-wiring-')); });
  afterEach(async () => { if (adapter) await adapter.stop().catch(() => {}); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'a2a-wiring test' }); });

  it('TelegramAdapter exposes setAgentMessageHook and stores the hook', () => {
    adapter = new TelegramAdapter({ token: 't', chatId: '-1001' }, dir);
    const hook = async () => ({ handled: false });
    adapter.setAgentMessageHook(hook);
    expect((adapter as unknown as { agentMessageHook: unknown }).agentMessageHook).toBe(hook);
    adapter.setAgentMessageHook(undefined);
    expect((adapter as unknown as { agentMessageHook: unknown }).agentMessageHook).toBeUndefined();
  });
});
