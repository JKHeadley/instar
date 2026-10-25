import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile, symlink } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { inspectOriginCertification, fingerprintOriginPackage } from '../../../src/messaging/telegram-origin/OriginCertification.js';
import { OriginProductionEnrollment } from '../../../src/messaging/telegram-origin/OriginProductionEnrollment.js';
import { originCertificationFixture } from '../../helpers/originCertification.js';

const roots: string[] = [];
async function fixture() { const f = await originCertificationFixture(); roots.push(f.root); return f; }
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-enrollment:cleanup' }); });
describe('release-bound production enrollment', () => {
  it('verifies complete package bytes and retains original approval/trial times on cached observations', async () => {
    const f = await fixture(); let now = f.now;
    const collector = new OriginProductionEnrollment({ packageRoot: f.root, selfMachineId: 'self', accountId: '123',
      activePeerIds: () => [], producerIds: () => ['telegram-server'], peerTransport: () => undefined, now: () => now });
    const first = await collector.inspect(); now += 5000;
    const cached = await collector.inspect();
    expect(first.map(item => item.state)).toEqual(['ready', 'ready', 'ready', 'not-applicable']);
    expect(cached[0].observedAt).toBe(first[0].observedAt);
    expect(cached[0].certification).toMatchObject({ approvedAt: f.body.approvedAt, expiresAt: f.body.expiresAt, trials: f.body.trials.map(({ kind, completedAt, evidenceDigest }) => ({ kind, completedAt, evidenceDigest })) });
    now = f.body.expiresAt;
    expect((await collector.inspect())[0]).toMatchObject({ state: 'unknown', reason: 'origin-release-certification-expired-or-future' });
  });
  it('rejects a different authority and the existing unrelated signature domain', async () => {
    const f = await fixture();
    await f.issue(f.body, generateKeyPairSync('ed25519').privateKey);
    expect(await inspectOriginCertification(f.root, f.now)).toMatchObject({ state: 'unknown', reason: 'origin-release-certification-signature-invalid' });
    await f.issue(f.body, undefined, 'agent-md-lockfile\n');
    expect(await inspectOriginCertification(f.root, f.now)).toMatchObject({ state: 'unknown', reason: 'origin-release-certification-signature-invalid' });
  });
  it.each(['modify', 'add', 'omit-root', 'symlink'] as const)('rejects package drift without a certificate-controlled file list: %s', async mode => {
    const f = await fixture();
    if (mode === 'modify') await writeFile(path.join(f.root, 'dist/sender.js'), 'changed code');
    if (mode === 'add') await writeFile(path.join(f.root, 'dist/unlisted.js'), 'new sender');
    if (mode === 'omit-root') await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ name: 'instar', files: ['src/templates', 'src/data', 'scripts'] }));
    if (mode === 'symlink') await symlink(path.join(f.root, 'package.json'), path.join(f.root, 'scripts/link'));
    expect((await inspectOriginCertification(f.root, f.now)).state).toBe('unknown');
  });
  it('does not let certificate self-bytes change the build hash, but binds reviewed entrypoints and trial completeness', async () => {
    const f = await fixture(); const before = await fingerprintOriginPackage(f.root);
    await f.issue({ ...f.body, census: { ...f.body.census, entrypoints: ['dist/not-present.js'] } });
    expect((await fingerprintOriginPackage(f.root)).digest).toBe(before.digest);
    expect(await inspectOriginCertification(f.root, f.now)).toMatchObject({ state: 'unknown', reason: 'origin-release-certification-census-invalid' });
    await f.issue({ ...f.body, trials: f.body.trials.slice(1) });
    expect((await inspectOriginCertification(f.root, f.now)).state).toBe('unknown');
  });
  it('allows lazy certified producers but rejects registration as proof of new author binding', async () => {
    const f = await fixture(); const live = ['telegram-server'];
    const collector = new OriginProductionEnrollment({ packageRoot: f.root, selfMachineId: 'self', accountId: '123',
      activePeerIds: () => [], producerIds: () => live, peerTransport: () => undefined });
    expect((await collector.inspect())[0].state).toBe('ready');
    live.push('lazy-fixture'); expect((await collector.inspect())[0].state).toBe('ready');
    live.push('unreviewed'); expect((await collector.inspect())[0]).toMatchObject({ state: 'unknown', reason: 'active-producer-without-certified-author-binding' });
  });
  it('reports missing release evidence as actionable unknown while reading the actual peer inventory', async () => {
    const f = await fixture();
    const collector = new OriginProductionEnrollment({ packageRoot: path.join(f.root, 'missing'), selfMachineId: 'self', accountId: '123',
      activePeerIds: () => ['self', 'peer'], producerIds: () => [], peerTransport: () => undefined });
    const observations = await collector.inspect();
    expect(observations[0].reason).toBe('origin-release-certification-not-installed:release-pipeline-issuance-required');
    expect(observations.at(-1)).toMatchObject({ state: 'unknown', reason: 'authenticated-origin-peer-transport-not-attached' });
  });
  it('bounds hung capability observations and rejects revoked or mismatched peer replies', async () => {
    const f = await fixture(); let peers = ['peer']; let mode = 'wrong';
    const collector = new OriginProductionEnrollment({ packageRoot: f.root, selfMachineId: 'self', accountId: '123',
      activePeerIds: () => peers, producerIds: () => ['telegram-server'], peerTransport: () => async () => {
        if (mode === 'hung') return new Promise(() => undefined);
        if (mode === 'revoked') peers = [];
        return { ok: true, result: { ok: true, protocol: 'instar-telegram-origin-v1', executionOwnerMachineId: mode === 'wrong' ? 'other' : 'peer', credentialOwner: true, accountId: '123' } };
      } });
    expect((await collector.inspect()).at(-1)?.state).toBe('unknown');
    mode = 'revoked'; expect((await collector.inspect()).at(-1)?.reason).toBe('origin-peer-authority-changed-during-observation');
    peers = ['peer']; mode = 'hung'; vi.useFakeTimers();
    const pending = collector.inspect(); await vi.advanceTimersByTimeAsync(2001);
    expect((await pending).at(-1)?.reason).toBe('origin-peer-capability-unavailable');
  });
});
