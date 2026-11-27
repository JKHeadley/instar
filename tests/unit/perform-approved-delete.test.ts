/**
 * SEC-018 companion: performApprovedDelete — the one server-side gated-delete op both
 * MCP transports funnel through. Proves the load-bearing security property (gate enabled
 * + no device approval ⇒ owner-approval-required + NO mutation, server-composed card),
 * plus not-found, dark, and approved paths.
 */
import { describe, it, expect, vi } from 'vitest';
import { performApprovedDelete } from '../../src/threadline/performApprovedDelete.js';
import type { OwnerApprovalGate } from '../../src/threadline/ThreadlineMCPServer.js';

function fakeMap(entry: Record<string, unknown> | null) {
  return { get: vi.fn(() => entry as never), remove: vi.fn() };
}
function fakeGate(over: Partial<OwnerApprovalGate> = {}): OwnerApprovalGate {
  return {
    enabled: () => true,
    consume: vi.fn(() => null),
    registerPending: vi.fn(),
    clearPending: vi.fn(),
    machineName: () => 'TestMachine',
    ...over,
  };
}

describe('performApprovedDelete (SEC-018 companion)', () => {
  it('thread missing → not-found, registers nothing, never mutates', () => {
    const map = fakeMap(null);
    const gate = fakeGate();
    const r = performApprovedDelete('thr_missing', { threadResumeMap: map, ownerApproval: gate });
    expect(r).toEqual({ ok: false, reason: 'not-found' });
    expect(map.remove).not.toHaveBeenCalled();
    expect(gate.registerPending).not.toHaveBeenCalled();
    expect(gate.consume).not.toHaveBeenCalled();
  });

  it('gate ABSENT (dark) → deletes, byte-identical to today', () => {
    const map = fakeMap({ subject: 'X', remoteAgent: 'peer', messageCount: 3, state: 'active' });
    const r = performApprovedDelete('thr_1', { threadResumeMap: map });
    expect(r.ok).toBe(true);
    expect(map.remove).toHaveBeenCalledWith('thr_1');
  });

  it('gate DISABLED (enabled()=false) → deletes, no consume', () => {
    const map = fakeMap({ subject: 'X' });
    const gate = fakeGate({ enabled: () => false });
    const r = performApprovedDelete('thr_1', { threadResumeMap: map, ownerApproval: gate });
    expect(r.ok).toBe(true);
    expect(map.remove).toHaveBeenCalledWith('thr_1');
    expect(gate.consume).not.toHaveBeenCalled();
  });

  it('CORE: enabled + NO approval → owner-approval-required, NO mutation, server-composed card', () => {
    const map = fakeMap({ subject: 'Design chat', remoteAgent: 'peer', messageCount: 9, state: 'active' });
    const gate = fakeGate({ consume: vi.fn(() => null) });
    const r = performApprovedDelete('thr_42', { threadResumeMap: map, ownerApproval: gate });
    expect(r).toEqual({ ok: false, reason: 'owner-approval-required' });
    expect(map.remove).not.toHaveBeenCalled(); // the hostile-caller property: cannot delete
    expect(gate.consume).toHaveBeenCalledWith({ purpose: 'thread-delete', actionKey: 'thr_42' });
    // the card is composed from the SERVER's thread state (the subject), never caller input
    expect(gate.registerPending).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'thread-delete', actionKey: 'thr_42', machine: 'TestMachine',
      title: 'Delete the conversation "Design chat"?',
    }));
  });

  it('server-composed card falls back to remoteAgent then a generic label when no subject', () => {
    const gate = fakeGate();
    performApprovedDelete('t', { threadResumeMap: fakeMap({ remoteAgent: 'Dawn' }), ownerApproval: gate });
    expect(gate.registerPending).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete the conversation "Dawn"?' }));
    const gate2 = fakeGate();
    performApprovedDelete('t', { threadResumeMap: fakeMap({}), ownerApproval: gate2 });
    expect(gate2.registerPending).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete the conversation "this conversation"?' }));
  });

  it('enabled + VALID approval → consumes, clears pending, deletes, returns info', () => {
    const map = fakeMap({ subject: 'Design chat', remoteAgent: 'peer', messageCount: 9, state: 'active' });
    const gate = fakeGate({ consume: vi.fn(() => 'approval-id-xyz') });
    const r = performApprovedDelete('thr_42', { threadResumeMap: map, ownerApproval: gate });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.info).toMatchObject({ threadId: 'thr_42', subject: 'Design chat', messageCount: 9, state: 'active' });
    expect(gate.clearPending).toHaveBeenCalledWith('thread-delete', 'thr_42');
    expect(map.remove).toHaveBeenCalledWith('thr_42');
  });
});
