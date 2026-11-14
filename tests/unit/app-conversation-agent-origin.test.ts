/**
 * message-origin-all-platforms §3 (app): an agent reply carries `agentOrigin` in the same event;
 * it is kept only on agent rows, only when valid, only for the machine that wrote the event, and
 * it survives replication's wire format.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConversationStore, validateAppEvent, type AppEvent } from '../../src/core/AppConversationStore.js';
import { appEventFromReplicatedData, buildAppConversationRecordData } from '../../src/core/AppConversationsReplicatedStore.js';
import { originEvidenceFromLaunchRecord } from '../../src/messaging/messageOrigin.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-conversation-agent-origin.test.ts' }); });
const KEY = '2f0c8a3e-1b2c-4d5e-8f90-1234567890ab';
const origin = (machineId = 'm1') => originEvidenceFromLaunchRecord({ machineId, machineName: 'Mac Studio', sessionId: 's', framework: 'claude-code', model: 'claude-opus-5-5', at: 1 });
const reply = (over: Record<string, unknown> = {}): AppEvent => ({ eventId: 'ev-r', kind: 'message', conversationKey: KEY, messageId: 'msg-r', role: 'agent',
  text: 'Saturday at nine.', at: new Date().toISOString(), machineId: 'm1', agentOrigin: origin(), ...over } as AppEvent);

describe('agentOrigin on app events', () => {
  it('keeps a valid origin on an agent reply and returns it from browse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appconv-origin-')); dirs.push(dir);
    const store = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
    store.append({ eventId: 'cr', kind: 'created', conversationKey: KEY, title: 'Plans', at: new Date().toISOString(), machineId: 'm1' });
    store.append(reply());
    const browsed = store.browseMessages(KEY, null, 10).messages;
    expect(browsed[0].agentOrigin).toEqual(origin());
    store.close();
  });
  it('drops it on an operator row, on a machine mismatch and when malformed', () => {
    expect((validateAppEvent({ ...reply(), role: 'operator' }) as { agentOrigin?: unknown }).agentOrigin).toBeUndefined();
    expect((validateAppEvent(reply({ agentOrigin: origin('m2') })) as { agentOrigin?: unknown }).agentOrigin).toBeUndefined();
    expect((validateAppEvent(reply({ agentOrigin: { ...origin(), v: 9 } })) as { agentOrigin?: unknown }).agentOrigin).toBeUndefined();
    // The message itself is never refused for its origin.
    expect(validateAppEvent(reply({ agentOrigin: 'junk' }))).not.toBeNull();
  });
  it('rides replication: the wire record carries it and the receiver re-validates it', () => {
    const data = buildAppConversationRecordData(reply())({ wall: 1, logical: 0, node: 'm1' } as never, 'm1')!;
    expect(data.agentOrigin).toEqual(origin());
    expect((appEventFromReplicatedData(data) as { agentOrigin?: unknown }).agentOrigin).toEqual(origin());
  });
});
