/**
 * The sealed identity handover — spec agent-identity-continuity-on-expansion.md §1.
 *
 * Acceptance criteria 3, 4, 5, 6c. The tests lean on the REJECTION paths, because the whole
 * point of the design is that a failed handover must never become a minted twin: every
 * rejection here is a case where the joiner provisions nothing.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  sealIdentityForJoiner,
  openHandoverEnvelope,
  fingerprintOf,
  type HandoverTranscript,
  type HandoverPayload,
} from '../../src/core/AgentIdentityHandover.js';

/** A real X25519 keypair, the shape a joining machine generates during pairing. */
function joinerKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return {
    publicB64: spki.subarray(spki.length - 32).toString('base64'),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

const agentKeys = crypto.generateKeyPairSync('ed25519');
const agentPubB64 = (agentKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
  .subarray(-32).toString('base64');
const AGENT_FP = fingerprintOf(agentPubB64);

const payload: HandoverPayload = {
  identity: { publicKey: agentPubB64, privateKey: 'cHJpdmF0ZS1rZXktYnl0ZXM=', createdAt: '2026-01-01T00:00:00.000Z' },
  provenance: {
    schemaVersion: 1,
    origin: 'minted-standalone',
    rootFingerprint: AGENT_FP,
    machineId: 'm_root',
    createdAt: '2026-01-01T00:00:00.000Z',
    producedBy: '1.3.1180',
  },
};

function transcript(over: Partial<HandoverTranscript> = {}, joinerPub = 'x'): HandoverTranscript {
  return {
    pairingSessionId: 'sess-1',
    joinerMachineId: 'm_joiner',
    joinerEncryptionPublicKey: joinerPub,
    agentName: 'echo',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...over,
  };
}

describe('sealIdentityForJoiner', () => {
  it('seals to the joiner key and carries the transcript + fingerprint', () => {
    const j = joinerKeys();
    const r = sealIdentityForJoiner({ payload, transcript: transcript({}, j.publicB64), identityFingerprint: AGENT_FP });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.identityFingerprint).toBe(AGENT_FP);
    expect(r.envelope.transcript.joinerEncryptionPublicKey).toBe(j.publicB64);
    // The identity must not be readable from the envelope without the joiner's private key.
    expect(JSON.stringify(r.envelope)).not.toContain(payload.identity.privateKey);
  });

  it('refuses a malformed joiner key by NAME rather than returning a partial envelope', () => {
    const r = sealIdentityForJoiner({ payload, transcript: transcript({}, 'not-a-key'), identityFingerprint: AGENT_FP });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe('malformed-joiner-key');
  });

  it('refuses an empty joiner key', () => {
    const r = sealIdentityForJoiner({ payload, transcript: transcript({}, ''), identityFingerprint: AGENT_FP });
    expect(r.ok).toBe(false);
  });
});

describe('openHandoverEnvelope — every rejection provisions nothing', () => {
  function sealed(joinerPub: string) {
    const r = sealIdentityForJoiner({ payload, transcript: transcript({}, joinerPub), identityFingerprint: AGENT_FP });
    if (!r.ok) throw new Error('seal failed');
    return r.envelope;
  }

  it('opens for the intended joiner (criterion 3 happy path)', () => {
    const j = joinerKeys();
    const r = openHandoverEnvelope({
      envelope: sealed(j.publicB64),
      expected: transcript({}, j.publicB64),
      pinnedFingerprint: AGENT_FP,
      joinerEncryptionPrivateKeyPem: j.privatePem,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.identity.publicKey).toBe(agentPubB64);
  });

  it('a THIRD machine cannot open an envelope captured in transit (criterion 4)', () => {
    const intended = joinerKeys();
    const attacker = joinerKeys();
    const r = openHandoverEnvelope({
      envelope: sealed(intended.publicB64),
      expected: transcript({}, intended.publicB64),
      pinnedFingerprint: AGENT_FP,
      joinerEncryptionPrivateKeyPem: attacker.privatePem, // replayed by someone else
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection).toBe('undecryptable');
  });

  it('rejects an envelope minted for a DIFFERENT session', () => {
    const j = joinerKeys();
    const r = openHandoverEnvelope({
      envelope: sealed(j.publicB64),
      expected: transcript({ pairingSessionId: 'sess-OTHER' }, j.publicB64),
      pinnedFingerprint: AGENT_FP,
      joinerEncryptionPrivateKeyPem: j.privatePem,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection).toBe('transcript-session-mismatch');
  });

  it('rejects an envelope minted for a DIFFERENT machine', () => {
    const j = joinerKeys();
    const r = openHandoverEnvelope({
      envelope: sealed(j.publicB64),
      expected: transcript({ joinerMachineId: 'm_other' }, j.publicB64),
      pinnedFingerprint: AGENT_FP,
      joinerEncryptionPrivateKeyPem: j.privatePem,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection).toBe('transcript-machine-mismatch');
  });

  it('rejects an envelope for a different AGENT name', () => {
    const j = joinerKeys();
    const r = openHandoverEnvelope({
      envelope: sealed(j.publicB64),
      expected: transcript({ agentName: 'someone-else' }, j.publicB64),
      pinnedFingerprint: AGENT_FP,
      joinerEncryptionPrivateKeyPem: j.privatePem,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection).toBe('transcript-agent-mismatch');
  });

  it('rejects an EXPIRED envelope (criterion 5)', () => {
    const j = joinerKeys();
    const env = sealIdentityForJoiner({
      payload,
      transcript: transcript({ expiresAt: new Date(Date.now() - 1000).toISOString() }, j.publicB64),
      identityFingerprint: AGENT_FP,
    });
    if (!env.ok) throw new Error('seal failed');
    const r = openHandoverEnvelope({
      envelope: env.envelope,
      expected: env.envelope.transcript,
      pinnedFingerprint: AGENT_FP,
      joinerEncryptionPrivateKeyPem: j.privatePem,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection).toBe('expired');
  });

  it('refuses an identity that does not match the PINNED fingerprint — the hostile-listener case', () => {
    // A listener that merely collected the code cannot produce the agent's keypair, so the
    // fingerprint carried in the operator's pairing artefact is what stops a fabricated identity.
    const j = joinerKeys();
    const r = openHandoverEnvelope({
      envelope: sealed(j.publicB64),
      expected: transcript({}, j.publicB64),
      pinnedFingerprint: 'f'.repeat(32),
      joinerEncryptionPrivateKeyPem: j.privatePem,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection).toBe('fingerprint-not-pinned');
  });

  it('refuses when the SEALED contents disagree with the advertised fingerprint', () => {
    // A well-formed envelope that advertises one identity and carries another.
    const j = joinerKeys();
    const other = crypto.generateKeyPairSync('ed25519');
    const otherPub = (other.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
    const env = sealIdentityForJoiner({
      payload: { ...payload, identity: { ...payload.identity, publicKey: otherPub } },
      transcript: transcript({}, j.publicB64),
      identityFingerprint: AGENT_FP, // lies about what is inside
    });
    if (!env.ok) throw new Error('seal failed');
    const r = openHandoverEnvelope({
      envelope: env.envelope,
      expected: env.envelope.transcript,
      pinnedFingerprint: AGENT_FP,
      joinerEncryptionPrivateKeyPem: j.privatePem,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection).toBe('fingerprint-mismatch');
  });

  it('refuses an unsupported schema rather than parsing it partially', () => {
    const j = joinerKeys();
    const env = { ...sealed(j.publicB64), schemaVersion: 99 as unknown as 1 };
    const r = openHandoverEnvelope({
      envelope: env,
      expected: transcript({}, j.publicB64),
      pinnedFingerprint: AGENT_FP,
      joinerEncryptionPrivateKeyPem: j.privatePem,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection).toBe('schema-unsupported');
  });
});
