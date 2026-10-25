/**
 * Generates compatibility vectors FROM INSTAR'S OWN CODE (src/threadline), so threadline-core's
 * tests prove byte-compatibility against the real implementation, not against a copy of it.
 * Run from the repo root:  NODE_ENV=development npx vite-node packages/threadline-core/test/fixtures/generate-instar-vectors.ts
 * Writes instar-vectors.json next to this file. Re-run only when Instar's envelope changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { MessageEncryptor, computeFingerprint, deriveX25519PublicKey } from '../../../../src/threadline/client/MessageEncryptor.js';
import { derivePairingIdV2, edPublicToX25519 } from '../../../../src/threadline/ThreadlineCrypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const seed = (label: string) => crypto.createHash('sha256').update(`threadline-core-vector:${label}`).digest();
const pubFromSeed = (s: Buffer) => {
  const k = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), s]), format: 'der', type: 'pkcs8' });
  return Buffer.from(crypto.createPublicKey(k).export({ type: 'spki', format: 'der' }).subarray(-32));
};

const aSeed = seed('alice'), bSeed = seed('bob');
const aPub = pubFromSeed(aSeed), bPub = pubFromSeed(bSeed);
const alice = new MessageEncryptor(aSeed, aPub);
const bob = new MessageEncryptor(bSeed, bPub);

const messages = [
  { content: 'hello from instar', type: 'chat' },
  { content: '', type: 'pair-invite-finish', metadata: { iid: 'ab'.repeat(16) } },
  { content: 'unicode ✓ – done', resend: true },
];
const envelopes = messages.map((m, i) => ({
  message: m,
  envelope: alice.encrypt(bPub, bob.x25519Public, `thread-${i}`, m, `msg-${i}`),
}));

const out = {
  generatedBy: 'instar src/threadline (MessageEncryptor, ThreadlineCrypto)',
  alice: { seed: aSeed.toString('hex'), pub: aPub.toString('hex'), fp: computeFingerprint(aPub), x25519FromSeed: deriveX25519PublicKey(aSeed).toString('hex'), x25519FromPub: edPublicToX25519(aPub).toString('hex') },
  bob: { seed: bSeed.toString('hex'), pub: bPub.toString('hex'), fp: computeFingerprint(bPub), x25519FromSeed: deriveX25519PublicKey(bSeed).toString('hex'), x25519FromPub: edPublicToX25519(bPub).toString('hex') },
  pairingId: derivePairingIdV2(aPub, bPub),
  envelopesAliceToBob: envelopes,
};
fs.writeFileSync(path.join(here, 'instar-vectors.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote instar-vectors.json');
