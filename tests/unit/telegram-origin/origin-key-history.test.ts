import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureOriginContentDedup } from '../../helpers/originContentDedup.js';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { IdentityStore } from '../../../src/core/IdentityStore.js';
import { MachineIdentityManager } from '../../../src/core/MachineIdentity.js';
import type { MachineIdentity } from '../../../src/core/types.js';
import { resolveIdentityOriginKey } from '../../../src/messaging/telegram-origin/OriginIdentityKeys.js';
import { attestOrigin, verifyOriginAttestation, verifyHistoricalOriginAttestation } from '../../../src/messaging/telegram-origin/OriginAttestation.js';
import { TelegramOriginRuntime } from '../../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const keys = () => { const pair = generateKeyPairSync('ed25519'); return {
  publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }; };

async function fixture() {
  const initial = keys(), replacement = keys(), stateDir = temporaryState();
  let now = Date.now() - 1000;
  const identities = new IdentityStore({ stateDir, now: () => now });
  const identity: MachineIdentity = { machineId: 'source', signingPublicKey: initial.publicKey, encryptionPublicKey: 'encryption',
    name: 'Source', platform: 'darwin-arm64', createdAt: '2020-01-01T00:00:00.000Z', capabilities: [], keyEpoch: 0, recoveryEpoch: 0 };
  fs.mkdirSync(path.join(stateDir, 'machines'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'machines/registry.json'), JSON.stringify({ version: 1,
    machines: { source: { name: 'Source', status: 'active', role: 'standby', pairedAt: 'x', lastSeen: 'x' } } }));
  identities.apply({ identity, scope: 'remote', actor: 'pairing-trust', path: 'pair' });
  const runtime = await TelegramOriginRuntime.open({ storage: { stateDir, agentId: 'echo' }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'source', originMachineName: 'Source' },
    signingKey: { privateKey: initial.privateKey, keyId: 'source:0', keyEpoch: 0 }, bot: { accountId: '123' },
    display: () => ({}), authorize: () => true, diagnoseUnknown: async () => undefined,
    resolveOriginKey: (machine, epoch) => resolveIdentityOriginKey(identities, machine, 'echo', epoch),
    authorizeOrigin: record => { const key = resolveIdentityOriginKey(identities, 'source', 'echo');
      return !!key && verifyOriginAttestation(record, key, { machineId: 'source', agentId: 'echo' }, now).valid; },
    alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined });
  cleanups.push(() => runtime.close());
  runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) });
  const operation = runtime.service.runAsAutomation('telegram-server', () => runtime.service.prepareBot({ method: 'sendMessage', accountId: '123',
    params: { chat_id: '-100123', message_thread_id: 12, text: 'Historical message' } }));
  now = Date.now();
  return { initial, replacement, stateDir, identities, identity, runtime, operation, now: () => now,
    rotate: () => { now += 1000; identities.apply({ identity: { ...identity, signingPublicKey: replacement.publicKey, keyEpoch: 1 },
      scope: 'remote', actor: 'reannounce', path: 'signing-rotation' }); },
    revoke: () => { now += 1000; identities.revoke('source', 'operator', 'test'); } };
}

describe('retained origin key epochs and acceptance evidence', () => {
  it('retains public bytes and actual local trust intervals through rotation, revocation, worker restart and archive', async () => {
    const h = await fixture();
    await h.runtime.service.admit(h.operation);
    const before = (await h.runtime.store.getOrigin(h.operation.record.originId))!;
    expect(before.acceptanceVerification).toMatchObject({ keyId: 'source:0', keyStatusAtAcceptance: 'active' });
    expect(before.record.envelopeJson).toBe(h.operation.admission.record.envelopeJson);
    await h.runtime.store.recordOperationState({ operationId: h.operation.record.operationId, state: 'suppressed' });
    await h.runtime.store.archive({ before: Date.now() + 10_000 });
    h.rotate(); h.revoke();
    const key = resolveIdentityOriginKey(new IdentityStore({ stateDir: h.stateDir }), 'source', 'echo', 0)!;
    expect(key.validFrom).toBeGreaterThan(Date.parse(h.identity.createdAt));
    expect(key.validUntil).toBeLessThan(key.revokedAt!);
    expect(verifyOriginAttestation(h.operation.record, key, { machineId: 'source', agentId: 'echo' }, h.now())).toEqual({ valid: false, reason: 'key-revoked' });
    const reopened = await OriginStore.open({ stateDir: h.stateDir, agentId: 'echo' }, worker); cleanups.push(() => reopened.close());
    const archived = (await reopened.getOrigin(h.operation.record.originId))!;
    expect(archived.acceptanceVerification).toEqual(before.acceptanceVerification);
    expect(verifyHistoricalOriginAttestation(h.operation.record, key, archived.acceptanceVerification!, h.now())).toMatchObject({
      signatureValid: true, keyStatus: 'revoked', signedDuringKnownValidity: 'valid', verificationBeforeRevocation: 'yes' });
    await reopened.putVerifiedEvidence({ record: h.operation.admission.record, verification: { ...before.acceptanceVerification!, verifiedAt: h.now() } });
    expect((await reopened.getOrigin(h.operation.record.originId))!.acceptanceVerification).toEqual(before.acceptanceVerification);
  });

  it('holds a queued operation after rotation and after revocation without a network attempt', async () => {
    const h = await fixture(); await h.runtime.service.admit(h.operation); h.rotate();
    const network = vi.fn();
    await expect(h.runtime.service.executePreparedBot(h.operation, network)).rejects.toMatchObject({ reason: 'origin-authority-revoked' });
    h.revoke();
    await expect(h.runtime.service.executePreparedBot(h.operation, network)).rejects.toMatchObject({ reason: 'origin-authority-revoked' });
    expect(network).not.toHaveBeenCalled();
  });

  it('does not invent acceptance or a historical validity start for a legacy key preserved before leave', async () => {
    const h = await fixture();
    const local = { ...h.identity, machineId: 'legacy', keyEpoch: 7 };
    fs.mkdirSync(path.join(h.stateDir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(h.stateDir, 'machine/identity.json'), JSON.stringify(local));
    const before = resolveIdentityOriginKey(h.identities, 'legacy', 'echo')!;
    expect(before).toMatchObject({ keyEpoch: 7, validFrom: null });
    new MachineIdentityManager(h.stateDir).removeLocalIdentity();
    expect(fs.existsSync(path.join(h.stateDir, 'machine/identity.json'))).toBe(false);
    const retained = resolveIdentityOriginKey(new IdentityStore({ stateDir: h.stateDir }), 'legacy', 'echo', 7)!;
    expect(retained.publicKey).toBe(before.publicKey); expect(retained.validFrom).toBeNull();
    const { attestation: _old, ...unsigned } = h.operation.record;
    const record = { ...unsigned, originMachineId: 'legacy', attestation: attestOrigin({ ...unsigned, originMachineId: 'legacy' },
      { privateKey: h.initial.privateKey, keyId: 'legacy:7', keyEpoch: 7 }) };
    expect(verifyHistoricalOriginAttestation(record, retained, null)).toMatchObject({ signatureValid: true,
      signedDuringKnownValidity: 'unknown', acceptedVerifiedAt: null, verificationBeforeRevocation: 'unknown' });
  });

  it('rejects a signature from a superseded key even when it claims a valid old signing time', async () => {
    const h = await fixture(); h.rotate();
    const old = resolveIdentityOriginKey(h.identities, 'source', 'echo', 0)!;
    expect(verifyOriginAttestation(h.operation.record, old, { machineId: 'source', agentId: 'echo' }, h.now()))
      .toEqual({ valid: false, reason: 'key-superseded' });
    expect(verifyHistoricalOriginAttestation(h.operation.record, old, null, h.now())).toMatchObject({
      signatureValid: true, keyStatus: 'superseded', acceptedVerifiedAt: null });
  });
});
