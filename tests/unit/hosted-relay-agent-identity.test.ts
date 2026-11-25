import { createHash, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FencedLease } from '../../src/core/FencedLease.js';
import { signOwnerRecordEntry, type OwnerRecordEntry } from '../../src/core/ownerRecord.js';
import { readHostedRelayAgentPin, type HostedRelayAgentPin } from '../../src/hostedRelay/agentIdentity.js';
import { createHostedRelayOwnerEvidenceReader } from '../../src/hostedRelay/ownerLeaseReader.js';

it('accepts only the current signed agent key and refuses old owner history or lease epochs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-agent-pin-'));
  try {
    const hostname = 'agent.relay.example', agentId = 'agent-one', holder = 'm_first';
    const assignment = '4'.repeat(64);
    function key() {
      const pair = generateKeyPairSync('ed25519');
      return { pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        sign: (message: string) => sign(null, Buffer.from(message), pair.privateKey).toString('base64') };
    }
    function certificate(name: string, label: string) {
      const cert = path.join(root, label + '.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=' + name, '-keyout', path.join(root, label + '.key'), '-out', cert], { stdio: 'ignore', timeout: 10000 });
      const x509 = new X509Certificate(fs.readFileSync(cert));
      return { der: x509.raw, pin: createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') };
    }
    const first = certificate(hostname, 'first'), next = certificate(hostname, 'second');
    const wrongName = certificate('different.relay.example', 'wrong-name');
    const firstMachine = key(), owner = key(), otherMachine = key();
    const genesis = signOwnerRecordEntry({ kind: 'genesis', agentId, parents: [],
      body: { machineId: holder, publicKey: firstMachine.pem, level: 'basic', agentProducible: true },
      signer: { type: 'machine', keyId: holder } }, firstMachine.sign);
    const enrolled = signOwnerRecordEntry({ kind: 'add-owner-key', agentId, parents: [genesis.id],
      body: { keyId: 'o_owner', publicKey: owner.pem, label: 'fixture', proof: 'fixture' },
      signer: { type: 'owner-key', keyId: 'o_owner' } }, owner.sign);
    function tls(parent: string, keyId: string, fingerprint: string, seq: number, signer: typeof firstMachine) {
      return signOwnerRecordEntry({ kind: 'tls-key', agentId, parents: [parent],
        body: { machineId: keyId, fingerprint, seq }, signer: { type: 'machine', keyId } }, signer.sign);
    }
    const firstTls = tls(enrolled.id, holder, first.pin, 1, firstMachine);
    const rotation = tls(enrolled.id, holder, next.pin, 2, firstMachine);
    const registration = { agentId, assignment, pinnedGenesis: genesis.id, entries: [] as OwnerRecordEntry[] };
    const signedLease = (epoch: number, machine: string, signer: typeof firstMachine) => {
      const base = { epoch, holder: machine, acquiredAt: new Date(1000).toISOString(), expiresAt: new Date(20_000).toISOString(), nonce: epoch };
      return { ...base, signature: signer.sign(FencedLease.canonicalize(base)) };
    };
    let lease = signedLease(1, holder, firstMachine);
    const currentEvidence = createHostedRelayOwnerEvidenceReader({
      registration: name => name === hostname ? registration : undefined,
      committedLease: id => id === agentId ? lease : undefined,
      verifyFirstOwnerProof: body => body.proof === 'fixture', now: () => 5000,
    });
    const setup = { locator: { kind: 'relay-locator' as const, hostname, origin: 'https://' + hostname },
      trusted: { agentId, assignment, genesis: genesis.id }, currentEvidence };
    const verify = (certificateDer: Buffer, previous?: HostedRelayAgentPin) =>
      readHostedRelayAgentPin({ ...setup, certificateDer, previous });
    registration.entries = [genesis.entry, enrolled.entry, firstTls.entry];
    const original = verify(first.der)!;
    const wrongTls = tls(enrolled.id, holder, wrongName.pin, 2, firstMachine);
    registration.entries.push(wrongTls.entry);
    expect(verify(wrongName.der, original)).toBeUndefined();
    registration.entries.pop();
    expect(original.spkiSha256).toBe(first.pin);
    expect(verify(next.der, original)).toBeUndefined();
    registration.entries.push(rotation.entry);
    const rotated = verify(next.der, original)!;
    expect(rotated.spkiSha256).toBe(next.pin);
    expect(verify(first.der, original)).toBeUndefined();
    registration.entries.pop();
    expect(verify(first.der, rotated)).toBeUndefined();

    const add = signOwnerRecordEntry({ kind: 'add-machine-key', agentId, parents: [enrolled.id],
      body: { machineId: 'm_other', publicKey: otherMachine.pem }, signer: { type: 'owner-key', keyId: 'o_owner' } }, owner.sign);
    const moved = tls(add.id, 'm_other', first.pin, 1, otherMachine);
    registration.entries.push(rotation.entry, add.entry, moved.entry);
    lease = signedLease(1, 'm_other', otherMachine);
    expect(verify(first.der, rotated)).toBeUndefined();
    lease = signedLease(2, 'm_other', otherMachine);
    const takeover = verify(first.der, rotated)!;
    expect(takeover).toMatchObject({ holder: 'm_other', leaseEpoch: 2, spkiSha256: first.pin });
    lease = signedLease(3, holder, firstMachine);
    registration.entries = registration.entries.filter(entry => entry !== rotation.entry);
    expect(verify(first.der, takeover)).toBeUndefined();
    registration.entries.push(rotation.entry);
    expect(verify(next.der, takeover)).toMatchObject({ holder, leaseEpoch: 3, spkiSha256: next.pin });
    expect(readHostedRelayAgentPin({ ...setup, trusted: { ...setup.trusted, assignment: '5'.repeat(64) }, certificateDer: first.der })).toBeUndefined();
  } finally {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'agent TLS pin fixture cleanup' });
  }
});
