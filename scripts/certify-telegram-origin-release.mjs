#!/usr/bin/env node
/** Explicit release operation only; normal build never calls this tool. */
import { constants } from 'node:fs';
import { open, link } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { canonicalOrigin, parseOriginJson } from '../dist/messaging/telegram-origin/CanonicalOrigin.js';
import { fingerprintOriginPackage, verifyOriginCertificationCandidate, ORIGIN_CERTIFICATE_DOMAIN,
  ORIGIN_CERTIFICATE_PATH, ORIGIN_RELEASE_KEY_PATH } from '../dist/messaging/telegram-origin/OriginCertification.js';
import { SafeFsExecutor } from '../dist/core/SafeFsExecutor.js';

const toolRoot = fileURLToPath(new URL('../', import.meta.url));
class IssuanceError extends Error {}
const refuse = code => { throw new IssuanceError(code); };
async function readBounded(file, maximum) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) refuse('input-size-or-type-invalid');
    const bytes = Buffer.alloc(stat.size + 1); let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, null);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    if (used !== stat.size) refuse('input-changed-during-read');
    return bytes.subarray(0, used).toString('utf8');
  } finally { await handle.close(); }
}
async function privateKey() {
  // Same release-key inputs and precedence as sign-instar-lockfile.mjs.
  // An explicitly selected unreadable key fails; it never falls through to a
  // different authority. Key contents and key paths never appear in output.
  if (process.env.INSTAR_RELEASE_PRIVATE_KEY_PEM) return process.env.INSTAR_RELEASE_PRIVATE_KEY_PEM;
  if (process.env.INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH) return readBounded(process.env.INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH, 16 * 1024);
  return readBounded(path.join(toolRoot, '.instar-release-keys/private.pem'), 16 * 1024);
}
function exactKeys(object, names) {
  return object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).length === names.length && names.every(name => Object.hasOwn(object, name));
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: npm run release:certify-telegram-origin -- --package-root <final-package-directory> --review <approved-review.json>');
    console.log('Requires separately approved, build-bound inventory/binding/trial evidence and the pinned Instar release signing key. Normal builds do not certify.');
    return;
  }
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--package-root', '--review'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) refuse('invalid-command-arguments');
    flags.set(args[i], args[i + 1]);
  }
  if (flags.size !== 2) refuse('package-root-and-approved-review-required');
  const root = path.resolve(flags.get('--package-root'));
  const review = parseOriginJson(await readBounded(path.resolve(flags.get('--review')), 2 * 1024 * 1024));
  if (!exactKeys(review, ['decision', 'certificate']) || review.decision !== 'approved') refuse('explicit-approved-review-required');
  const body = review.certificate;
  if (!exactKeys(body, ['schema', 'approvedAt', 'expiresAt', 'reviewEvidenceDigest', 'buildDigest', 'producers', 'census', 'trials']) ||
    !Array.isArray(body.producers) || !body.producers.every(item => exactKeys(item, ['producerId', 'entrypoints', 'authorContract', 'bindingEvidenceDigest'])) ||
    !exactKeys(body.census, ['complete', 'entrypoints', 'evidenceDigest']) || !Array.isArray(body.trials) ||
    !body.trials.every(item => exactKeys(item, ['kind', 'completedAt', 'passed', 'evidenceDigest']))) refuse('review-manifest-schema-invalid');
  const build = await fingerprintOriginPackage(root);
  // Never replace the reviewed digest with a fresh digest: a changed package
  // needs another reviewed manifest, not automatic re-certification.
  if (body.buildDigest !== build.digest) refuse('reviewed-build-does-not-match-final-package');
  let signingKey, pinnedKey;
  try { signingKey = createPrivateKey(await privateKey()); pinnedKey = createPublicKey(await readBounded(path.join(root, ORIGIN_RELEASE_KEY_PATH), 16 * 1024)); }
  catch { refuse('release-signing-authority-unavailable'); }
  if (signingKey.asymmetricKeyType !== 'ed25519' || pinnedKey.asymmetricKeyType !== 'ed25519' ||
    !createPublicKey(signingKey).export({ type: 'spki', format: 'der' }).equals(pinnedKey.export({ type: 'spki', format: 'der' }))) refuse('signing-key-does-not-match-pinned-release-authority');
  const candidate = { ...body, signature: sign(null, Buffer.from(ORIGIN_CERTIFICATE_DOMAIN + canonicalOrigin(body)), signingKey).toString('base64url') };
  const bytes = canonicalOrigin(candidate) + '\n';
  const result = await verifyOriginCertificationCandidate(root, bytes);
  if (result.state !== 'ready') refuse(result.reason);

  // Stage alongside (outside) the package so staging bytes cannot change its
  // fingerprint. A hard link publishes complete bytes atomically, refuses an
  // existing certificate, and cannot cross filesystems. No partial output.
  const temporary = path.join(path.dirname(root), `.origin-certification-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o644);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await link(temporary, path.join(root, ORIGIN_CERTIFICATE_PATH));
  }
  finally { await SafeFsExecutor.safeUnlink(temporary, { operation: 'origin-release-certification:remove-private-staging-file' }); }
  console.log('Origin release certificate created; reviewed build and original evidence times preserved.');
}

main().catch(error => {
  // Do not log raw parser/filesystem/crypto errors or review/key contents.
  console.error(`Origin release certification refused: ${error instanceof IssuanceError ? error.message : 'input-or-output-unavailable'}`);
  process.exitCode = 1;
});
