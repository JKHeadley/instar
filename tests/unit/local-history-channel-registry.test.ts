import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalHistoryChannelRegistry } from '../../src/import/LocalHistoryChannelRegistry.js';
import { LocalHistoryChannel, type LocalHistoryChannelRoute } from '../../src/import/LocalHistoryChannel.js';
import { finishLocalHistoryHandshake, LOCAL_HISTORY_CHANNEL_TTL_MS } from '../../src/import/LocalHistoryHandshake.js';

const registries: LocalHistoryChannelRegistry[] = [];
const device = { deviceId: 'synthetic-device', deviceKeyHash: 'synthetic-key-hash' };
const route: LocalHistoryChannelRoute = { method: 'POST', path: '/mobile/imported-history/local/library' };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { for (const registry of registries.splice(0)) registry.stop(); vi.useRealTimers(); });
function setup(capacity = 32) {
  const signing = crypto.generateKeyPairSync('ed25519');
  let owner: string | null = 'synthetic-owner';
  let registeredKey = device.deviceKeyHash;
  let issuer = { agentId: 'synthetic-agent', machineId: 'synthetic-machine', bootId: 'synthetic-boot',
    signingKeyHash: crypto.createHash('sha256').update(signing.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') };
  const signer = vi.fn((bytes: Buffer) => crypto.sign(null, bytes, signing.privateKey).toString('base64'));
  const registry = new LocalHistoryChannelRegistry({
    principal: request => owner === null ? null : { ...request, ownerUserId: owner, deviceKeyHash: registeredKey }, issuer: () => issuer,
    sign: signer, capacity,
  });
  registries.push(registry);
  const issue = (selected = device) => {
    const ephemeral = crypto.createECDH('prime256v1'); ephemeral.generateKeys();
    const request = { machineId: issuer.machineId, clientNonce: crypto.randomBytes(32).toString('base64'), clientPublicKey: ephemeral.getPublicKey().toString('base64') };
    const grant = registry.issue(selected, request);
    const keys = finishLocalHistoryHandshake(grant, request, { ...issuer, ...selected }, ephemeral, signing.publicKey, Date.now());
    try { return { grant, client: new LocalHistoryChannel(keys, grant, 'client') }; }
    finally { keys.request.fill(0); keys.response.fill(0); }
  };
  return { registry, issue, signer, owner: (value: string | null) => { owner = value; },
    key: (value: string) => { registeredKey = value; }, issuer: (value: Partial<typeof issuer>) => { issuer = { ...issuer, ...value }; } };
}
it('uses the real target handshake and owns buffers through complete response disposal', () => {
  const f = setup(), { grant, client } = f.issue();
  const wire = client.sealRequest(Buffer.from('synthetic private query'), route);
  const lease = f.registry.open(device, grant.channelId, route, wire);
  expect(lease.plaintext.toString()).toBe('synthetic private query');
  expect(f.registry.resources()).toEqual({ retained: 1, active: 1, inFlight: 1 });
  expect(() => f.registry.open(device, grant.channelId, route, wire)).toThrow('channel-busy');
  const source = Buffer.from('synthetic response'); const response = lease.sealResponse(source);
  expect(source.equals(Buffer.alloc(source.length))).toBe(true);
  expect(client.openResponse(response, route).toString()).toBe('synthetic response');
  lease.close(); lease.close();
  expect(lease.plaintext.equals(Buffer.alloc(lease.plaintext.length))).toBe(true);
  expect(response.equals(Buffer.alloc(response.length))).toBe(true);
  expect(wire.equals(Buffer.alloc(wire.length))).toBe(true);
  expect(f.registry.resources()).toEqual({ retained: 1, active: 1, inFlight: 0 });
  const next = f.registry.open(device, grant.channelId, route, client.sealRequest(Buffer.from('next'), route));
  client.openResponse(next.sealResponse(Buffer.from('reply')), route); next.close();
});
it('expires idle channels without another request', () => {
  const f = setup(); f.issue();
  vi.advanceTimersByTime(LOCAL_HISTORY_CHANNEL_TTL_MS);
  expect(f.registry.resources()).toEqual({ retained: 0, active: 0, inFlight: 0 });
});
it('aborts expired in-flight work but retains capacity until its actual close', () => {
  const f = setup(1), { grant, client } = f.issue();
  const lease = f.registry.open(device, grant.channelId, route, client.sealRequest(Buffer.from('synthetic'), route));
  vi.advanceTimersByTime(LOCAL_HISTORY_CHANNEL_TTL_MS);
  expect(lease.signal.aborted).toBe(true);
  expect(f.registry.resources()).toEqual({ retained: 1, active: 0, inFlight: 1 });
  expect(() => lease.sealResponse(Buffer.from('cannot publish'))).toThrow('channel-unavailable');
  expect(() => f.issue()).toThrow('channel-capacity');
  lease.close();
  expect(f.registry.resources().retained).toBe(0);
  expect(f.issue().grant.channelId).toEqual(expect.any(String));
});
it('supersedes a channel without forgetting its still-held exchange', () => {
  const f = setup(), old = f.issue();
  const lease = f.registry.open(device, old.grant.channelId, route, old.client.sealRequest(Buffer.from('old'), route));
  const replacement = f.issue();
  expect(lease.signal.aborted).toBe(true);
  expect(f.registry.resources()).toEqual({ retained: 2, active: 1, inFlight: 1 });
  lease.close();
  const next = f.registry.open(device, replacement.grant.channelId, route, replacement.client.sealRequest(Buffer.from('new'), route));
  expect(next.plaintext.toString()).toBe('new');
  replacement.client.openResponse(next.sealResponse(Buffer.from('reply')), route); next.close();
});
it('rejects a foreign device without invalidating the rightful channel', () => {
  const f = setup(), { grant, client } = f.issue(); const wire = client.sealRequest(Buffer.from('synthetic'), route);
  expect(() => f.registry.open({ ...device, deviceId: 'different' }, grant.channelId, route, wire)).toThrow('channel-unavailable');
  expect(() => f.registry.open({ ...device, deviceKeyHash: 'wrong-key' }, grant.channelId, route, wire)).toThrow('channel-unavailable');
  expect(f.registry.resources().active).toBe(1);
  const lease = f.registry.open(device, grant.channelId, route, wire);
  expect(lease.plaintext.toString()).toBe('synthetic'); lease.close();
});
it.each(['owner', 'revoke', 'boot', 'key', 'signing-key'] as const)('rechecks live %s before response publication', change => {
  const f = setup(), { grant, client } = f.issue();
  const lease = f.registry.open(device, grant.channelId, route, client.sealRequest(Buffer.from('synthetic'), route));
  if (change === 'owner') f.owner('another-owner');
  if (change === 'revoke') f.owner(null);
  if (change === 'boot') f.issuer({ agentId: grant.agentId, machineId: grant.machineId, bootId: 'different-boot' });
  if (change === 'key') f.key('rotated-device-key');
  if (change === 'signing-key') f.issuer({ signingKeyHash: 'a'.repeat(64) });
  const body = Buffer.from('no private result');
  expect(() => lease.sealResponse(body)).toThrow('channel-unavailable');
  expect(body.equals(Buffer.alloc(body.length))).toBe(true);
  expect(lease.signal.aborted).toBe(true); lease.close();
  expect(f.registry.resources().retained).toBe(0);
});
it('refuses tampering and abandons an incomplete exchange instead of reusing its channel', () => {
  const f = setup(), { grant, client } = f.issue();
  const wire = client.sealRequest(Buffer.from('synthetic'), route); wire[wire.length - 1] ^= 1;
  expect(() => f.registry.open(device, grant.channelId, route, wire)).toThrow('channel-invalid');
  expect(f.registry.resources().retained).toBe(0);
  const next = f.issue();
  const lease = f.registry.open(device, next.grant.channelId, route, next.client.sealRequest(Buffer.from('next'), route));
  lease.close(); expect(f.registry.resources().retained).toBe(0);
});
it('invalidates a revoked device and keeps stop idempotent with held work', () => {
  const f = setup(), { grant, client } = f.issue();
  const lease = f.registry.open(device, grant.channelId, route, client.sealRequest(Buffer.from('synthetic'), route));
  f.registry.invalidateDevice(device.deviceId);
  expect(lease.signal.aborted).toBe(true);
  f.registry.stop(); f.registry.stop();
  expect(() => f.issue()).toThrow('channel-unavailable');
  expect(f.registry.resources().retained).toBe(1);
  lease.close(); expect(f.registry.resources().retained).toBe(0);
});
it('fails closed on clock rollback and missing unique owner identity', () => {
  const f = setup(), { grant, client } = f.issue();
  vi.setSystemTime(Date.now() - 1);
  expect(() => f.registry.open(device, grant.channelId, route, client.sealRequest(Buffer.from('synthetic'), route))).toThrow('channel-unavailable');
  f.owner(''); expect(() => f.issue()).toThrow('channel-unavailable');
});

it('refuses exactly at expiry even when the cleanup timer callback is delayed', () => {
  const f = setup(), { grant, client } = f.issue();
  vi.setSystemTime(grant.expiresAt - 1);
  const lease = f.registry.open(device, grant.channelId, route, client.sealRequest(Buffer.from('synthetic'), route));
  expect(lease.signal.aborted).toBe(false);
  vi.setSystemTime(grant.expiresAt);
  expect(f.registry.resources().active).toBe(1); // no timer callback ran
  expect(() => lease.sealResponse(Buffer.from('late'))).toThrow('channel-unavailable');
  lease.close();
  const next = f.issue(); vi.setSystemTime(next.grant.expiresAt);
  expect(() => f.registry.open(device, next.grant.channelId, route, next.client.sealRequest(Buffer.from('late request'), route))).toThrow('channel-unavailable');
});
it('preserves a valid held exchange when rekey has no spare capacity and does not sign', () => {
  const f = setup(1), { grant, client } = f.issue();
  const lease = f.registry.open(device, grant.channelId, route, client.sealRequest(Buffer.from('synthetic'), route));
  const signed = f.signer.mock.calls.length;
  expect(() => f.issue()).toThrow('channel-capacity');
  expect(f.signer).toHaveBeenCalledTimes(signed);
  expect(lease.signal.aborted).toBe(false);
  expect(client.openResponse(lease.sealResponse(Buffer.from('still valid')), route).toString()).toBe('still valid');
  lease.close(); expect(f.issue().grant.channelId).not.toBe(grant.channelId);
});
it('blocks synchronous reentrant issuance from an abort listener', () => {
  const f = setup(), old = f.issue();
  const lease = f.registry.open(device, old.grant.channelId, route, old.client.sealRequest(Buffer.from('old'), route));
  let refusal = '';
  lease.signal.addEventListener('abort', () => {
    lease.close();
    try { f.issue(); } catch (error) { refusal = (error as Error).message; }
  });
  const replacement = f.issue();
  expect(refusal).toBe('local-history-channel-busy');
  expect(f.registry.resources()).toEqual({ retained: 1, active: 1, inFlight: 0 });
  const next = f.registry.open(device, replacement.grant.channelId, route, replacement.client.sealRequest(Buffer.from('new'), route));
  replacement.client.openResponse(next.sealResponse(Buffer.from('reply')), route); next.close();
});
it('does not publish a new channel when an abort listener stops the registry', () => {
  const f = setup(), old = f.issue();
  const lease = f.registry.open(device, old.grant.channelId, route, old.client.sealRequest(Buffer.from('old'), route));
  lease.signal.addEventListener('abort', () => { lease.close(); f.registry.stop(); });
  expect(() => f.issue()).toThrow('channel-unavailable');
  expect(f.registry.resources().retained).toBe(0);
});
it('schedules only the remaining lifetime after signing consumes time', () => {
  const f = setup(), sign = f.signer.getMockImplementation()!;
  f.signer.mockImplementationOnce(bytes => { vi.setSystemTime(Date.now() + 1000); return sign(bytes); });
  f.issue();
  vi.advanceTimersByTime(LOCAL_HISTORY_CHANNEL_TTL_MS - 1001);
  expect(f.registry.resources().active).toBe(1);
  vi.advanceTimersByTime(1);
  expect(f.registry.resources().retained).toBe(0);
});
it.each([LOCAL_HISTORY_CHANNEL_TTL_MS, -1])('does not publish when signing moves the clock out of the grant window by %s', offset => {
  const f = setup(), sign = f.signer.getMockImplementation()!;
  f.signer.mockImplementationOnce(bytes => { vi.setSystemTime(Date.now() + offset); return sign(bytes); });
  expect(() => f.issue()).toThrow('channel-unavailable');
  expect(f.registry.resources().retained).toBe(0);
});
it('refuses a rollback from the later signing watermark during abort callbacks', () => {
  const f = setup(), old = f.issue(), sign = f.signer.getMockImplementation()!;
  const lease = f.registry.open(device, old.grant.channelId, route, old.client.sealRequest(Buffer.from('old'), route));
  f.signer.mockImplementationOnce(bytes => { vi.setSystemTime(Date.now() + 1000); return sign(bytes); });
  lease.signal.addEventListener('abort', () => { lease.close(); vi.setSystemTime(Date.now() - 500); });
  expect(() => f.issue()).toThrow('channel-unavailable');
  expect(f.registry.resources().retained).toBe(0);
});
