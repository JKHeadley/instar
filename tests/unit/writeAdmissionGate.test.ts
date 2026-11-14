import { describe, it, expect } from 'vitest';
import { resolveWriteAdmissionGate } from '../../src/core/writeAdmissionGate.js';

describe('resolveWriteAdmissionGate', () => {
  it('turns on for a fleet agent so the shared Conversations graph can open', () => {
    expect(resolveWriteAdmissionGate({})).toEqual({ enabled: true, reason: 'conversations' });
    expect(resolveWriteAdmissionGate({ developmentAgent: false, multiMachine: {} })).toEqual({ enabled: true, reason: 'conversations' });
  });
  it('keeps the dev-agent reason on a development agent', () => {
    expect(resolveWriteAdmissionGate({ developmentAgent: true })).toEqual({ enabled: true, reason: 'dev-agent' });
  });
  it('an explicit setting always wins, including false with Conversations on', () => {
    expect(resolveWriteAdmissionGate({ developmentAgent: true, multiMachine: { writeAdmission: { enabled: false } } })).toEqual({ enabled: false, reason: 'explicit' });
    expect(resolveWriteAdmissionGate({ multiMachine: { writeAdmission: { enabled: true }, conversationGraph: { storage: { enabled: false } } } })).toEqual({ enabled: true, reason: 'explicit' });
  });
  it('stays off when the owned-default graph is not in use', () => {
    expect(resolveWriteAdmissionGate({ multiMachine: { conversationGraph: { storage: { enabled: false } } } })).toEqual({ enabled: false, reason: 'off' });
    expect(resolveWriteAdmissionGate({ multiMachine: { conversationGraph: { witness: { witnessId: 'w' } } } })).toEqual({ enabled: false, reason: 'off' });
  });
  it('handles a missing config', () => {
    expect(resolveWriteAdmissionGate(undefined).enabled).toBe(true);
  });
});
