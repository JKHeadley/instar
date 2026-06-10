/**
 * Duplicate-identity name-resolution tests for ThreadlineClient.
 *
 * Drives the REAL on-path resolver (resolveAgent / findAgentByName / ingestDiscoveredAgents)
 * — the exact functions threadline_send uses — per
 * docs/specs/threadline-duplicate-identity-resolution.md (changes A/B/C). These tests fail
 * on current main / after any relay-only change: the silent-drop fix lives in the client.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ThreadlineClient } from '../../../src/threadline/client/ThreadlineClient.js';

type Priv = {
  knownAgents: Map<string, { agentId: string; name: string; online?: boolean; publicKey?: Buffer; x25519PublicKey?: Buffer }>;
  findAgentByName(name: string, prefix?: string): { agentId: string } | undefined;
  ingestDiscoveredAgents(agents: Array<Record<string, unknown>>): void;
  autoDiscover(): Promise<void>;
  relayClient: unknown;
};

function seed(
  client: ThreadlineClient,
  agentId: string,
  name: string,
  online: boolean,
  extra: Record<string, unknown> = {},
): void {
  (client as unknown as Priv).knownAgents.set(agentId, { agentId, name, online, ...extra });
}

describe('ThreadlineClient — duplicate-identity name resolution (§A/§B/§C)', () => {
  let fakeNow: number;
  let client: ThreadlineClient;
  let p: Priv;

  beforeEach(() => {
    fakeNow = 1_000_000;
    client = new ThreadlineClient({ name: 'Tester', stateDir: '/tmp/resolve-test' }, () => fakeNow);
    p = client as unknown as Priv;
  });

  // ── §B findAgentByName online-preference (exact) ──

  it('resolves a live-vs-dead same-name pair to the LIVE fingerprint (the core fix)', () => {
    seed(client, 'live01', 'echo', true);
    seed(client, 'dead02', 'echo', false);
    expect(p.findAgentByName('echo')?.agentId).toBe('live01');
  });

  it('throws ambiguity when TWO same-name rows are both online (never silently picks)', () => {
    seed(client, 'liveA', 'echo', true);
    seed(client, 'liveB', 'echo', true);
    expect(() => p.findAgentByName('echo')).toThrow(/Ambiguous/);
  });

  it('throws ambiguity when both same-name rows are offline (no live to prefer)', () => {
    seed(client, 'd1', 'echo', false);
    seed(client, 'd2', 'echo', false);
    expect(() => p.findAgentByName('echo')).toThrow(/Ambiguous/);
  });

  it('a fingerprint prefix still wins over online-preference', () => {
    seed(client, 'aaaa01beef', 'echo', true);
    seed(client, 'bbbb02beef', 'echo', true);
    expect(p.findAgentByName('echo', 'bbbb')?.agentId).toBe('bbbb02beef');
  });

  it('a single match is returned regardless of liveness', () => {
    seed(client, 'only1', 'echo', false);
    expect(p.findAgentByName('echo')?.agentId).toBe('only1');
  });

  it('prefers the online row over a same-name row of unknown liveness (online===undefined)', () => {
    seed(client, 'live01', 'echo', true);
    (client as unknown as Priv).knownAgents.set('unk02', { agentId: 'unk02', name: 'echo' }); // online undefined
    expect(p.findAgentByName('echo')?.agentId).toBe('live01');
  });

  it('throws ambiguity when same-name rows are all of unknown liveness (none online)', () => {
    (client as unknown as Priv).knownAgents.set('u1', { agentId: 'u1', name: 'echo' });
    (client as unknown as Priv).knownAgents.set('u2', { agentId: 'u2', name: 'echo' });
    expect(() => p.findAgentByName('echo')).toThrow(/Ambiguous/);
  });

  // ── §B online-preference (partial branch parity) ──

  it('applies online-preference in the PARTIAL-match branch too', () => {
    seed(client, 'liveP', 'echo-prod', true);
    seed(client, 'deadP', 'echo-staging', false);
    expect(p.findAgentByName('echo')?.agentId).toBe('liveP');
  });

  // ── §A merge / online plumbing ──

  it('populates online=true from a discover_result status', () => {
    p.ingestDiscoveredAgents([{ agentId: 'x1', name: 'echo', status: 'online' }]);
    expect(p.knownAgents.get('x1')?.online).toBe(true);
  });

  it('populates online=false from a discover_result status', () => {
    p.ingestDiscoveredAgents([{ agentId: 'x2', name: 'echo', status: 'offline' }]);
    expect(p.knownAgents.get('x2')?.online).toBe(false);
  });

  it('MERGES — retains crypto keys when a keyless discover_result updates online', () => {
    const pk = Buffer.from('aa', 'hex');
    const xk = Buffer.from('bb', 'hex');
    seed(client, 'k1', 'echo', false, { publicKey: pk, x25519PublicKey: xk });
    // Keyless frame (the real DiscoverResultFrame shape) — must not strip keys.
    p.ingestDiscoveredAgents([{ agentId: 'k1', name: 'echo', status: 'online' }]);
    const e = p.knownAgents.get('k1');
    expect(e?.online).toBe(true);
    expect(e?.publicKey).toBe(pk);
    expect(e?.x25519PublicKey).toBe(xk);
  });

  // ── §C resolveAgent re-discovery terminals ──

  it('re-discovers when the only cached match is offline, then resolves to the now-live row', async () => {
    seed(client, 'dead02', 'echo', false);
    p.relayClient = {};
    (p as unknown as { autoDiscover: () => Promise<void> }).autoDiscover = async () => {
      seed(client, 'live01', 'echo', true);
    };
    expect(await client.resolveAgent('echo')).toBe('live01');
  });

  it('still-offline after re-discovery → returns the offline fingerprint (no 404 regression)', async () => {
    seed(client, 'dead02', 'echo', false);
    p.relayClient = {};
    (p as unknown as { autoDiscover: () => Promise<void> }).autoDiscover = async () => { /* nothing comes online */ };
    expect(await client.resolveAgent('echo')).toBe('dead02');
  });

  it('re-discovery yielding two now-online rows propagates the ambiguity throw', async () => {
    seed(client, 'dead02', 'echo', false);
    p.relayClient = {};
    (p as unknown as { autoDiscover: () => Promise<void> }).autoDiscover = async () => {
      p.knownAgents.delete('dead02');
      seed(client, 'liveA', 'echo', true);
      seed(client, 'liveB', 'echo', true);
    };
    await expect(client.resolveAgent('echo')).rejects.toThrow(/Ambiguous/);
  });

  it('per-name cooldown prevents a second offline re-discovery within the window', async () => {
    seed(client, 'dead02', 'echo', false);
    p.relayClient = {};
    let calls = 0;
    (p as unknown as { autoDiscover: () => Promise<void> }).autoDiscover = async () => { calls++; };
    await client.resolveAgent('echo'); // offline → re-discovers
    await client.resolveAgent('echo'); // within cooldown → no re-discover
    expect(calls).toBe(1);
    fakeNow += 31_000; // past the 30s cooldown
    await client.resolveAgent('echo'); // cooldown elapsed → re-discovers again
    expect(calls).toBe(2);
  });

  // ── §C discover() rate-limit early-resolve filter ──

  it('discover() ignores a NON-rate-limit error frame (does not early-resolve)', async () => {
    const fakeRelay = new EventEmitter() as EventEmitter & { discover: () => void };
    fakeRelay.discover = () => { /* no-op */ };
    p.relayClient = fakeRelay;
    const pr = client.discover({ name: 'echo' });
    fakeRelay.emit('error', { code: 'recipient_offline' }); // unrelated — must be ignored
    fakeRelay.emit('discover-result', { agents: [{ agentId: 'z1', name: 'echo', status: 'online' }] });
    const agents = await pr;
    expect(agents.map((a: { agentId: string }) => a.agentId)).toContain('z1');
  });

  it('discover() early-resolves [] on a rate-limit error frame (fail fast, no 10s hang)', async () => {
    const fakeRelay = new EventEmitter() as EventEmitter & { discover: () => void };
    fakeRelay.discover = () => { /* no-op */ };
    p.relayClient = fakeRelay;
    const pr = client.discover({ name: 'echo' });
    fakeRelay.emit('error', { code: 'rate_limited' });
    expect(await pr).toEqual([]);
  });
});
