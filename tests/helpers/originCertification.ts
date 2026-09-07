import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import path from 'node:path';
import { canonicalOrigin, wireDigest } from '../../src/messaging/telegram-origin/CanonicalOrigin.js';
import { fingerprintOriginPackage, ORIGIN_CERTIFICATE_DOMAIN, ORIGIN_CERTIFICATE_PATH, ORIGIN_REQUIRED_TRIALS,
  type OriginReleaseCertification } from '../../src/messaging/telegram-origin/OriginCertification.js';

/** Ephemeral fixture authority only. Never creates a real release certificate. */
export async function originCertificationFixture(now = Date.now(), installCertificate = true) {
  const root = await mkdtemp('/tmp/origin-certification-fixture-');
  const keys = generateKeyPairSync('ed25519');
  for (const directory of ['dist/keys', 'src/templates', 'src/data', 'scripts']) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'instar', files: ['dist', 'src/templates', 'src/data', 'scripts'] }));
  await writeFile(path.join(root, 'dist/keys/instar-release-pub.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(path.join(root, 'dist/sender.js'), 'export const fixtureSender = true;\n');
  const body: Omit<OriginReleaseCertification, 'signature'> = {
    schema: 'instar-telegram-origin-release-certification-v1', approvedAt: now - 1000, expiresAt: now + 60_000,
    reviewEvidenceDigest: wireDigest('fixture-review'), buildDigest: (await fingerprintOriginPackage(root)).digest,
    producers: ['telegram-server', 'lazy-fixture'].map(producerId => ({ producerId, entrypoints: ['dist/sender.js'],
      authorContract: 'mixed-explicit', bindingEvidenceDigest: wireDigest(`fixture-binding:${producerId}`) })),
    census: { complete: true, entrypoints: ['dist/sender.js'], evidenceDigest: wireDigest('fixture-census') },
    trials: ORIGIN_REQUIRED_TRIALS.map(kind => ({ kind, completedAt: now - 2000, passed: true, evidenceDigest: wireDigest(`fixture-trial:${kind}`) })),
  };
  const issue = async (value = body, signer = keys.privateKey, domain = ORIGIN_CERTIFICATE_DOMAIN) => {
    const certificate = { ...value, signature: sign(null, Buffer.from(domain + canonicalOrigin(value)), signer).toString('base64url') };
    await writeFile(path.join(root, ORIGIN_CERTIFICATE_PATH), JSON.stringify(certificate));
    return certificate;
  };
  if (installCertificate) await issue();
  return { root, body, issue, now, privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
