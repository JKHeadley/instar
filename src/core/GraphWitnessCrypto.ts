/** Bundle encryption runs on installed members. The remote witness never receives these keys. */
import crypto from 'node:crypto';
import { canonicalJson, canonicalHash, bundleCiphertextHash, GRAPH_SIGNATURE_DOMAINS, signGraphRecord, verifyBundleRewrap,
  type GraphEncryptedBundle, type GraphMembershipMember, type GraphMembershipEpoch, type GraphBundleRewrap } from './GraphWitnessTypes.js';

const b64 = (b: Buffer) => b.toString('base64url');
function encrypt(plaintext: Buffer, key: Buffer, aad: Buffer) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return { nonce: b64(nonce), ciphertext: b64(Buffer.concat([cipher.update(plaintext), cipher.final()])), tag: b64(cipher.getAuthTag()) };
}
function decrypt(data: { nonce: string; ciphertext: string; tag: string }, key: Buffer, aad: Buffer): Buffer {
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(data.nonce, 'base64url'));
  cipher.setAAD(aad); cipher.setAuthTag(Buffer.from(data.tag, 'base64url'));
  return Buffer.concat([cipher.update(Buffer.from(data.ciphertext, 'base64url')), cipher.final()]);
}
function wrappingKey(privateKey: crypto.KeyLike, publicKey: crypto.KeyLike, context: Buffer): Buffer {
  const shared = crypto.diffieHellman({ privateKey: privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey),
    publicKey: publicKey instanceof crypto.KeyObject ? publicKey : crypto.createPublicKey(publicKey) });
  try { return Buffer.from(crypto.hkdfSync('sha256', shared, context, Buffer.from('graph-witness-key-envelope-v1'), 32)); }
  finally { shared.fill(0); }
}
export function sealGraphBundle(plaintext: Buffer, members: GraphMembershipMember[], binding: { agentId: string; eventId: string }): GraphEncryptedBundle {
  binding = { agentId: binding.agentId, eventId: binding.eventId };
  const context = Buffer.from(canonicalJson(binding));
  const contentKey = crypto.randomBytes(32);
  try {
    const content = encrypt(plaintext, contentKey, context);
    const envelopes = members.map((member) => {
      const ephemeral = crypto.generateKeyPairSync('x25519');
      const key = wrappingKey(ephemeral.privateKey.export({ type: 'pkcs8', format: 'pem' }), member.sealingPublicKey, context);
      try {
        return { machineId: member.machineId, ephemeralPublicKey: ephemeral.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          ...encrypt(contentKey, key, Buffer.from(canonicalJson({ ...binding, machineId: member.machineId }))) };
      } finally { key.fill(0); }
    });
    return { v: 1, algorithm: 'aes-256-gcm+x25519-hkdf-sha256', ...content, envelopes };
  } finally { contentKey.fill(0); }
}
export function openGraphBundle(bundle: GraphEncryptedBundle, machineId: string, sealingPrivateKey: crypto.KeyLike,
  binding: { agentId: string; eventId: string }): Buffer {
  binding = { agentId: binding.agentId, eventId: binding.eventId };
  const envelope = bundle.envelopes.find((e) => e.machineId === machineId);
  if (!envelope) throw new Error('graph-bundle-envelope-unavailable');
  const context = Buffer.from(canonicalJson(binding));
  const key = wrappingKey(sealingPrivateKey, envelope.ephemeralPublicKey, context);
  let contentKey: Buffer | undefined;
  try {
    contentKey = decrypt(envelope, key, Buffer.from(canonicalJson({ ...binding, machineId })));
    if (contentKey.length !== 32) throw new Error('graph-bundle-key-invalid');
    return decrypt(bundle, contentKey, context);
  } finally { key.fill(0); contentKey?.fill(0); }
}
export function rewrapGraphBundle(bundle: GraphEncryptedBundle, survivingMachineId: string, survivingSealingPrivateKey: crypto.KeyLike,
  membership: GraphMembershipEpoch, writerId: string, writerSigningPrivateKey: crypto.KeyLike,
  binding: { agentId: string; eventId: string }, at = new Date().toISOString(), prior?:{rewrap:GraphBundleRewrap;membership:GraphMembershipEpoch}): GraphBundleRewrap {
  binding = { agentId: binding.agentId, eventId: binding.eventId };
  if (binding.agentId !== membership.agentId || !membership.members.some((m) => m.machineId === writerId)) throw new Error('graph-rewrap-membership-invalid');
  if(prior&&!verifyBundleRewrap(prior.rewrap,bundle,prior.membership))throw new Error('graph-rewrap-prior-proof-invalid');
  const oldEnvelope = (prior?.rewrap.envelopes??bundle.envelopes).find((e) => e.machineId === survivingMachineId);
  if (!oldEnvelope) throw new Error('graph-rewrap-survivor-envelope-missing');
  const context = Buffer.from(canonicalJson(binding));
  const wrapping = wrappingKey(survivingSealingPrivateKey, oldEnvelope.ephemeralPublicKey, context);
  let contentKey: Buffer | undefined;
  try {
    contentKey = decrypt(oldEnvelope, wrapping, Buffer.from(canonicalJson({ ...binding, machineId: survivingMachineId })));
    // A corrupt source must not gain a new recovery envelope or a member receipt.
    const checked = decrypt(bundle, contentKey, context); checked.fill(0);
    const envelopes = membership.members.map((member) => {
      const ephemeral = crypto.generateKeyPairSync('x25519');
      const key = wrappingKey(ephemeral.privateKey, member.sealingPublicKey, context);
      try { return { machineId: member.machineId, ephemeralPublicKey: ephemeral.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        ...encrypt(contentKey!, key, Buffer.from(canonicalJson({ ...binding, machineId: member.machineId }))) }; }
      finally { key.fill(0); }
    });
    const payload = { v: 1 as const, agentId: binding.agentId, eventId: binding.eventId, originalBundleHash: canonicalHash(bundle),
      ciphertextHash: bundleCiphertextHash(bundle), newMembershipHash: canonicalHash(membership), membershipEpoch: membership.epoch,
      writerId, envelopes, rewrappedAt: at };
    return { ...payload, signature: signGraphRecord(GRAPH_SIGNATURE_DOMAINS.rewrap, payload, writerSigningPrivateKey) };
  } finally { wrapping.fill(0); contentKey?.fill(0); }
}
export function openRewrappedGraphBundle(bundle: GraphEncryptedBundle, rewrap: GraphBundleRewrap, machineId: string,
  sealingPrivateKey: crypto.KeyLike, membership: GraphMembershipEpoch, binding: { agentId: string; eventId: string }): Buffer {
  if (!verifyBundleRewrap(rewrap, bundle, membership) || rewrap.agentId !== binding.agentId || rewrap.eventId !== binding.eventId) throw new Error('graph-rewrap-proof-invalid');
  return openGraphBundle({ ...bundle, envelopes: rewrap.envelopes }, machineId, sealingPrivateKey, binding);
}
