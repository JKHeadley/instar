#!/usr/bin/env node
/**
 * generate-instar-release-key.mjs — generate a fresh Ed25519 keypair for
 * signing the instar-default lock-file.
 *
 * Writes:
 *   .instar-release-keys/private.pem        (gitignored — never commit)
 *   src/scaffold/keys/instar-release-pub.pem (committed — bundled with package)
 *
 * The public key is committed to the repo because the runtime verifier needs
 * it bundled in the installed package. The private key is gitignored.
 *
 * For CI / GitHub Actions, set INSTAR_RELEASE_PRIVATE_KEY_PEM as a repository
 * secret containing the raw PEM contents. The sign-instar-lockfile script
 * reads from env first, falling back to this local dev key.
 *
 * Key rotation:
 *   - Regenerate by running this script. The new public key replaces the
 *     committed one.
 *   - Existing agents who haven't updated will have the old public key in
 *     their bundled dist/keys/instar-release-pub.pem and will treat the
 *     new lock-file as present-untrusted (degraded mode) until they update.
 *   - This is the documented compromised-key emergency procedure in
 *     docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md §Trust Model.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const PRIVATE_DIR = path.join(ROOT, '.instar-release-keys');
const PRIVATE_PATH = path.join(PRIVATE_DIR, 'private.pem');
const PUBLIC_DIR = path.join(ROOT, 'src', 'scaffold', 'keys');
const PUBLIC_PATH = path.join(PUBLIC_DIR, 'instar-release-pub.pem');

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');

  if (fs.existsSync(PRIVATE_PATH) && !force) {
    console.error(
      `[generate-key] Private key already exists at ${PRIVATE_PATH}. ` +
      `Use --force to overwrite (this will rotate the release key and invalidate ` +
      `all previously-signed lock-files until agents update).`,
    );
    process.exit(1);
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.writeFileSync(PRIVATE_PATH, privatePem, { encoding: 'utf-8', mode: 0o600 });

  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(PUBLIC_PATH, publicPem, { encoding: 'utf-8' });

  const fp = crypto
    .createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');

  console.log('[generate-key] Generated Ed25519 keypair.');
  console.log(`  Private: ${PRIVATE_PATH} (gitignored, mode 0600)`);
  console.log(`  Public:  ${PUBLIC_PATH} (commit this)`);
  console.log(`  KeyId:   instar-release/sha256:${fp}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. git add src/scaffold/keys/instar-release-pub.pem');
  console.log('  2. git commit');
  console.log('  3. npm run build  (signs dist/jobs/instar.lock.json)');
}

main();
