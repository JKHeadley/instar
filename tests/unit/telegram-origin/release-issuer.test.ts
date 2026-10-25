import { afterEach, describe, expect, it } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { inspectOriginCertification, ORIGIN_CERTIFICATE_PATH } from '../../../src/messaging/telegram-origin/OriginCertification.js';
import { originCertificationFixture } from '../../helpers/originCertification.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-release-issuer:cleanup' }); });
async function fixture() {
  const f = await originCertificationFixture(Date.now(), false); roots.push(f.root);
  const reviewPath = path.join(f.root, 'approved-review.json');
  const review = { decision: 'approved', certificate: f.body };
  const save = () => writeFile(reviewPath, JSON.stringify(review));
  await save();
  const run = (key = f.privateKeyPem, keyPath = path.join(f.root, 'missing-private-key.pem')) => spawnSync(process.execPath,
    [path.resolve('scripts/certify-telegram-origin-release.mjs'), '--package-root', f.root, '--review', reviewPath], {
      encoding: 'utf8', timeout: 15_000,
      // Never consult the real checkout's release key or inherited secret.
      env: { ...process.env, INSTAR_RELEASE_PRIVATE_KEY_PEM: key, INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH: keyPath },
    });
  return { ...f, review, save, run, output: path.join(f.root, ORIGIN_CERTIFICATE_PATH) };
}
describe('explicit Telegram origin release issuer', () => {
  it('round-trips fixture authority through the installed verifier without changing approval, trials or build identity', async () => {
    const f = await fixture(); const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const verified = await inspectOriginCertification(f.root);
    expect(verified.state).toBe('ready');
    if (verified.state !== 'ready') throw new Error('fixture certificate refused');
    expect(verified.certificate).toMatchObject(f.body);
    expect(result.stdout + result.stderr).not.toContain('PRIVATE KEY');
    expect(result.stdout + result.stderr).not.toContain(f.body.reviewEvidenceDigest);
    const original = await readFile(f.output, 'utf8');
    expect(f.run().status).toBe(1);
    expect(await readFile(f.output, 'utf8')).toBe(original);
  });
  it('uses the existing explicit PEM_PATH key input', async () => {
    const f = await fixture(), keyPath = path.join(f.root, 'fixture-private.pem');
    await writeFile(keyPath, f.privateKeyPem, { mode: 0o600 });
    const result = f.run('', keyPath);
    expect(result.status, result.stderr).toBe(0);
    expect((await inspectOriginCertification(f.root)).state).toBe('ready');
  });
  it.each(['unapproved', 'trial-missing', 'expired', 'build-drift', 'wrong-key', 'missing-key', 'private-extra'] as const)('refuses %s before creating output', async kind => {
    const f = await fixture(); let key = f.privateKeyPem;
    if (kind === 'unapproved') f.review.decision = 'pending';
    if (kind === 'trial-missing') f.review.certificate.trials.pop();
    if (kind === 'expired') f.review.certificate.expiresAt = Date.now() - 100;
    if (kind === 'build-drift') await writeFile(path.join(f.root, 'dist/sender.js'), 'unreviewed code');
    if (kind === 'wrong-key') key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    if (kind === 'missing-key') key = '';
    if (kind === 'private-extra') Object.assign(f.review.certificate, { privateNotes: 'PRIVATE_REVIEW_BODY_MUST_NOT_BE_PRINTED' });
    await f.save();
    const result = f.run(key);
    expect(result.status, result.stderr).toBe(1);
    await expect(access(f.output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.stdout + result.stderr).not.toContain('PRIVATE KEY');
    expect(result.stdout + result.stderr).not.toContain('PRIVATE_REVIEW_BODY');
    expect(result.stdout + result.stderr).not.toContain(f.body.reviewEvidenceDigest);
  });
  it('is an explicit command and is not part of ordinary build or prepublish lifecycle', async () => {
    const pkg = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
    expect(pkg.scripts['release:certify-telegram-origin']).toBe('node scripts/certify-telegram-origin-release.mjs');
    expect(pkg.scripts.build).not.toContain('certify-telegram-origin');
    expect(pkg.scripts.prepublishOnly).not.toContain('certify-telegram-origin');
  });
});
