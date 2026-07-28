import { describe, it, expect } from 'vitest';
import {
  DemoChannelRegistry,
  canonicalBindingsPayload,
  type DemoChannelBindingsDoc,
} from '../../src/core/DemoChannelRegistry.js';

// A trivial deterministic "signature" = the payload itself; verify checks equality.
// This exercises the verification PATH (right payload → valid; any mutation → invalid)
// without needing a real crypto host.
const sign = (payload: string): string => `sig:${payload}`;
const verify = (payload: string, signature: string): boolean => signature === `sig:${payload}`;

function signedDoc(bindings: DemoChannelBindingsDoc['bindings']): DemoChannelBindingsDoc {
  const unsigned = { version: 1 as const, machineId: 'laptop', bindings, signedAt: '2026-06-16T00:00:00Z' };
  return { ...unsigned, signature: sign(canonicalBindingsPayload(unsigned)) };
}

describe('DemoChannelRegistry', () => {
  it('absent bindings → zero demo channels, unverified, not an error', () => {
    const r = new DemoChannelRegistry({ doc: null, verify });
    expect(r.isVerified).toBe(false);
    expect(r.size).toBe(0);
    expect(r.isDemoChannel('slack', 'C123')).toBe(false);
    expect(r.isDemoChannel('telegram', '999')).toBe(false);
  });

  it('valid signed bindings → registered channels resolve true, others false', () => {
    const doc = signedDoc([
      { surface: 'slack', channelId: 'C123', workspaceId: 'W1', label: 'SageMind Live Test' },
      { surface: 'telegram', channelId: '555', label: 'demo group' },
    ]);
    const r = new DemoChannelRegistry({ doc, verify });
    expect(r.isVerified).toBe(true);
    expect(r.size).toBe(2);
    expect(r.isDemoChannel('slack', 'C123')).toBe(true);
    expect(r.isDemoChannel('telegram', '555')).toBe(true);
    // not registered
    expect(r.isDemoChannel('slack', 'C999')).toBe(false);
    // surface must match — same id on a different surface is NOT a demo channel
    expect(r.isDemoChannel('telegram', 'C123')).toBe(false);
  });

  it('FAIL-CLOSED: a tampered binding (added channel) invalidates the signature → 0 demo channels', () => {
    const doc = signedDoc([{ surface: 'slack', channelId: 'C123' }]);
    // Attacker appends a live operator channel after signing.
    doc.bindings.push({ surface: 'slack', channelId: 'C-OPERATOR-LIVE' });
    const r = new DemoChannelRegistry({ doc, verify });
    expect(r.isVerified).toBe(false);
    expect(r.size).toBe(0);
    // The smuggled channel does NOT become a demo channel.
    expect(r.isDemoChannel('slack', 'C-OPERATOR-LIVE')).toBe(false);
    // Neither does the originally-signed one — fail-closed grants nothing.
    expect(r.isDemoChannel('slack', 'C123')).toBe(false);
  });

  it('FAIL-CLOSED: a forged/empty signature grants nothing', () => {
    const doc = signedDoc([{ surface: 'slack', channelId: 'C123' }]);
    doc.signature = 'sig:not-the-real-payload';
    const r = new DemoChannelRegistry({ doc, verify });
    expect(r.isVerified).toBe(false);
    expect(r.isDemoChannel('slack', 'C123')).toBe(false);
  });

  it('FAIL-CLOSED: a verify() that throws is treated as unverified, never as valid', () => {
    const doc = signedDoc([{ surface: 'slack', channelId: 'C123' }]);
    const throwingVerify = () => { throw new Error('crypto host down'); };
    const r = new DemoChannelRegistry({ doc, verify: throwingVerify });
    expect(r.isVerified).toBe(false);
    expect(r.isDemoChannel('slack', 'C123')).toBe(false);
  });

  it('canonical payload is order-independent across the binding list (re-sort cannot change the signed bytes)', () => {
    const a = canonicalBindingsPayload({
      version: 1, machineId: 'm', signedAt: 't',
      bindings: [{ surface: 'slack', channelId: 'C1' }, { surface: 'telegram', channelId: '2' }],
    });
    const b = canonicalBindingsPayload({
      version: 1, machineId: 'm', signedAt: 't',
      bindings: [{ surface: 'telegram', channelId: '2' }, { surface: 'slack', channelId: 'C1' }],
    });
    expect(a).toBe(b);
  });

  it('SECURITY: no canonical collision across the channelId/workspaceId boundary (signature cannot be reused on a different binding)', () => {
    // The signer vouches for channel 'C1' in workspace 'W2'. An attacker tries to
    // reuse that signature to vouch for a DIFFERENT channelId 'C1W2' by sliding the
    // workspaceId into the channelId. With a delimiter-free encoding these would
    // collide; with the JSON-tuple encoding they must NOT.
    const signed = canonicalBindingsPayload({
      version: 1, machineId: 'm', signedAt: 't',
      bindings: [{ surface: 'slack', channelId: 'C1', workspaceId: 'W2' }],
    });
    const tampered = canonicalBindingsPayload({
      version: 1, machineId: 'm', signedAt: 't',
      bindings: [{ surface: 'slack', channelId: 'C1W2' }],
    });
    expect(signed).not.toBe(tampered);

    // End-to-end: the tampered doc (carrying the signature minted for the ORIGINAL)
    // must fail verification → the smuggled channel 'C1W2' is NOT a demo channel.
    const original = { version: 1 as const, machineId: 'm', signedAt: 't', bindings: [{ surface: 'slack' as const, channelId: 'C1', workspaceId: 'W2' }] };
    const sig = sign(canonicalBindingsPayload(original));
    const attackDoc = { version: 1 as const, machineId: 'm', signedAt: 't', bindings: [{ surface: 'slack' as const, channelId: 'C1W2' }], signature: sig };
    const r = new DemoChannelRegistry({ doc: attackDoc, verify });
    expect(r.isVerified).toBe(false);
    expect(r.isDemoChannel('slack', 'C1W2')).toBe(false);
  });

  it('SECURITY: absent vs present-empty workspaceId are distinguishable (no null/"" aliasing)', () => {
    const absent = canonicalBindingsPayload({
      version: 1, machineId: 'm', signedAt: 't',
      bindings: [{ surface: 'slack', channelId: 'C1' }],
    });
    const emptyWs = canonicalBindingsPayload({
      version: 1, machineId: 'm', signedAt: 't',
      bindings: [{ surface: 'slack', channelId: 'C1', workspaceId: '' }],
    });
    expect(absent).not.toBe(emptyWs);
  });

  it('canonical payload changes when any meaningful field changes (so the signature breaks)', () => {
    const base = { version: 1 as const, machineId: 'm', signedAt: 't', bindings: [{ surface: 'slack' as const, channelId: 'C1' }] };
    const p0 = canonicalBindingsPayload(base);
    expect(canonicalBindingsPayload({ ...base, machineId: 'other' })).not.toBe(p0);
    expect(canonicalBindingsPayload({ ...base, signedAt: 'later' })).not.toBe(p0);
    expect(canonicalBindingsPayload({ ...base, bindings: [{ surface: 'slack', channelId: 'C2' }] })).not.toBe(p0);
    expect(canonicalBindingsPayload({ ...base, bindings: [{ surface: 'slack', channelId: 'C1', workspaceId: 'W' }] })).not.toBe(p0);
  });
});
