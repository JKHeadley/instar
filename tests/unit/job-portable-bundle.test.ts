import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectPortableJob, validatePortableBundle } from '../../src/core/JobPortableBundle.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { verifyImportedPortableJob } from '../../src/core/JobPortableIntegrity.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'job-portable-test-cleanup' }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-job-'));
  roots.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'jobs', 'schedule'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'jobs', 'user'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects', 'data-scout'), { recursive: true });
  const manifest = {
    slug: 'data-scout', origin: 'user', schedule: '0 9 * * *', priority: 'medium',
    expectedDurationMinutes: 30, enabled: true, portable: true,
    requiredPaths: ['projects/data-scout'], execute: { type: 'agentmd' },
  };
  fs.writeFileSync(path.join(stateDir, 'jobs', 'schedule', 'data-scout.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(stateDir, 'jobs', 'user', 'data-scout.md'), '# Data scout\n');
  fs.writeFileSync(path.join(root, 'projects', 'data-scout', 'input.txt'), 'safe input');
  return { root, stateDir, manifest };
}

describe('private portable job projection', () => {
  it('collects only a declared user job and dependency with a stable content root', () => {
    const { root, stateDir } = fixture();
    const bundle = collectPortableJob(root, stateDir, 'data-scout');
    expect(bundle.files.map(f => f.path)).toEqual([
      '.instar/jobs/schedule/data-scout.json', '.instar/jobs/user/data-scout.md',
      'projects/data-scout/input.txt',
    ]);
    expect(validatePortableBundle(bundle).root).toBe(bundle.root);
    fs.writeFileSync(path.join(root, 'projects', 'data-scout', 'input.txt'), 'changed');
    expect(collectPortableJob(root, stateDir, 'data-scout').root).not.toBe(bundle.root);
  });
  it('refuses undeclared or secret-like dependency paths and unknown manifest fields', () => {
    const { root, stateDir, manifest } = fixture();
    const file = path.join(stateDir, 'jobs', 'schedule', 'data-scout.json');
    fs.writeFileSync(file, JSON.stringify({ ...manifest, apiToken: 'private' }));
    expect(() => collectPortableJob(root, stateDir, 'data-scout')).toThrow('unknown-manifest-field');
    fs.writeFileSync(file, JSON.stringify({ ...manifest, requiredPaths: ['config.json'] }));
    expect(() => collectPortableJob(root, stateDir, 'data-scout')).toThrow();
  });
  it('refuses secret-named children within an approved directory', () => {
    const { root, stateDir } = fixture();
    fs.writeFileSync(path.join(root, 'projects', 'data-scout', 'config.json'), '{"apiKey":"never-copy"}');
    expect(() => collectPortableJob(root, stateDir, 'data-scout')).toThrow('invalid-entry');
  });
  it('refuses a symlinked parent in the approved dependency tree', () => {
    const { root, stateDir } = fixture();
    const original = path.join(root, 'projects', 'data-scout');
    const moved = path.join(root, 'private-data');
    fs.renameSync(original, moved);
    fs.symlinkSync(moved, original);
    expect(() => collectPortableJob(root, stateDir, 'data-scout')).toThrow();
  });
  it('refuses a symlinked dependency and tampered received bytes', () => {
    const { root, stateDir } = fixture();
    const bundle = collectPortableJob(root, stateDir, 'data-scout');
    bundle.files[2].content = Buffer.from('tampered').toString('base64');
    expect(() => validatePortableBundle(bundle)).toThrow('invalid-file-hash');
    SafeFsExecutor.safeRmSync(path.join(root, 'projects', 'data-scout', 'input.txt'), { operation: 'job-portable-test-symlink' });
    fs.symlinkSync(path.join(root, 'private.txt'), path.join(root, 'projects', 'data-scout', 'input.txt'));
    expect(() => collectPortableJob(root, stateDir, 'data-scout')).toThrow('symlink-refused');
  });
});

describe('recipient-bound portable transport and approvals', () => {
  it('requires a signed requester and encrypted recipient-bound answer', async () => {
    const { root, stateDir } = fixture();
    const { makePortableBundleRequest, acceptPortableBundleRequest, makePortableBundleWire,
      acceptPortableBundleWire, PortableApprovalStore } = await import('../../src/core/JobPortableBundle.js');
    const { generateSigningKeyPair, generateEncryptionKeyPair } = await import('../../src/core/MachineIdentity.js');
    const crypto = await import('node:crypto');
    const source = generateSigningKeyPair();
    const recipient = generateSigningKeyPair();
    const encryption = generateEncryptionKeyPair();
    const sourceId = `m_${'1'.repeat(32)}`;
    const recipientId = `m_${'2'.repeat(32)}`;
    const request = makePortableBundleRequest(sourceId, recipientId, 'data-scout', 'a'.repeat(64), recipient.privateKey);
    expect(acceptPortableBundleRequest(request, sourceId, recipient.publicKey).slug).toBe('data-scout');
    expect(() => acceptPortableBundleRequest({ ...request, slug: 'other' }, sourceId, recipient.publicKey)).toThrow();
    const bundle = collectPortableJob(root, stateDir, 'data-scout');
    const exportApprovals = new PortableApprovalStore(stateDir, 'export');
    expect(exportApprovals.isApproved(bundle.slug, bundle.root)).toBe(false);
    exportApprovals.approve(bundle.slug, bundle.root);
    expect(exportApprovals.isApproved(bundle.slug, bundle.root)).toBe(true);
    const publicDer = crypto.createPublicKey(encryption.publicKey).export({ type: 'spki', format: 'der' });
    const wire = makePortableBundleWire(bundle, request, source.privateKey, Buffer.from(publicDer).toString('base64'), 1);
    expect(acceptPortableBundleWire(wire, request, source.publicKey, encryption.privateKey).root).toBe(bundle.root);
    expect(() => acceptPortableBundleWire({ ...wire, root: '0'.repeat(64) }, request, source.publicKey, encryption.privateKey)).toThrow();
    const other = generateEncryptionKeyPair();
    expect(() => acceptPortableBundleWire(wire, request, source.publicKey, other.privateKey)).toThrow();
    exportApprovals.revoke(bundle.slug);
    expect(exportApprovals.isApproved(bundle.slug, bundle.root)).toBe(false);
  });
});

describe('portable import admission', () => {
  it('quarantines a bundle until exact-root approval, installs manifest last, and revokes safely', async () => {
    const source = fixture();
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-destination-'));
    roots.push(destination);
    const destinationState = path.join(destination, '.instar');
    const bundle = collectPortableJob(source.root, source.stateDir, 'data-scout');
    const { JobPortableSync } = await import('../../src/core/JobPortableSync.js');
    const sync = new JobPortableSync({ stateDir: destinationState, projectDir: destination,
      identityManager: null as never, authToken: '' });
    const sourceId = `m_${'1'.repeat(32)}`;
    (sync as unknown as { writeInbox: (id: string, bundle: typeof bundle) => void }).writeInbox(sourceId, bundle);
    expect(sync.gaps()).toContainEqual(expect.stringContaining('awaits local approval'));
    expect(fs.existsSync(path.join(destinationState, 'jobs', 'schedule', 'data-scout.json'))).toBe(false);
    sync.approveImport(sourceId, 'data-scout', bundle.root);
    expect(fs.existsSync(path.join(destinationState, 'jobs', 'schedule', 'data-scout.json'))).toBe(true);
    expect(fs.readFileSync(path.join(destination, 'projects', 'data-scout', 'input.txt'), 'utf8')).toBe('safe input');
    expect(sync.gaps()).toEqual([]);
    expect(verifyImportedPortableJob(destinationState, destination, 'data-scout')).toBe(true);
    fs.writeFileSync(path.join(destination, 'projects', 'data-scout', 'input.txt'), 'local drift');
    expect(verifyImportedPortableJob(destinationState, destination, 'data-scout')).toBe(false);
    sync.revokeImport('data-scout');
    expect(fs.existsSync(path.join(destinationState, 'jobs', 'schedule', 'data-scout.json'))).toBe(false);
    expect(fs.existsSync(path.join(destination, 'projects', 'data-scout', 'input.txt'))).toBe(true);
  });
  it('updates a full-size owned file and restores it if journal commit fails', async () => {
    const source = fixture();
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-destination-'));
    roots.push(destination);
    const destinationState = path.join(destination, '.instar');
    const sourceFile = path.join(source.root, 'projects', 'data-scout', 'input.txt');
    const destinationFile = path.join(destination, 'projects', 'data-scout', 'input.txt');
    const firstBytes = Buffer.alloc(256 * 1024, 65);
    fs.writeFileSync(sourceFile, firstBytes);
    const first = collectPortableJob(source.root, source.stateDir, 'data-scout');
    const { JobPortableSync } = await import('../../src/core/JobPortableSync.js');
    const sync = new JobPortableSync({ stateDir: destinationState, projectDir: destination,
      identityManager: null as never, authToken: '' });
    const sourceId = `m_${'2'.repeat(32)}`;
    const inbox = sync as unknown as { writeInbox: (id: string, bundle: typeof first) => void;
      writeImportJournal: (jobs: unknown) => void };
    inbox.writeInbox(sourceId, first);
    sync.approveImport(sourceId, 'data-scout', first.root);
    expect(fs.readFileSync(destinationFile)).toEqual(firstBytes);

    const nextBytes = Buffer.alloc(256 * 1024, 66);
    fs.writeFileSync(sourceFile, nextBytes);
    const next = collectPortableJob(source.root, source.stateDir, 'data-scout');
    inbox.writeInbox(sourceId, next);
    const originalWrite = inbox.writeImportJournal.bind(inbox);
    let writes = 0;
    const fail = vi.spyOn(inbox, 'writeImportJournal').mockImplementation(jobs => {
      if (++writes === 2) throw new Error('journal-failure');
      originalWrite(jobs);
    });
    expect(() => sync.approveImport(sourceId, 'data-scout', next.root)).toThrow('journal-failure');
    expect(fs.readFileSync(destinationFile)).toEqual(firstBytes);
    fail.mockRestore();
    sync.approveImport(sourceId, 'data-scout', next.root);
    expect(fs.readFileSync(destinationFile)).toEqual(nextBytes);
  });
  it('withholds an imported manifest when its journal says apply was interrupted', async () => {
    const source = fixture();
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-destination-'));
    roots.push(destination);
    const stateDir = path.join(destination, '.instar');
    const bundle = collectPortableJob(source.root, source.stateDir, 'data-scout');
    const { JobPortableSync } = await import('../../src/core/JobPortableSync.js');
    const sync = new JobPortableSync({ stateDir, projectDir: destination,
      identityManager: null as never, authToken: '' });
    const sourceId = `m_${'3'.repeat(32)}`;
    const internals = sync as unknown as { writeInbox: (id: string, bundle: typeof bundle) => void;
      writeImportJournal: (jobs: unknown) => void };
    internals.writeInbox(sourceId, bundle);
    sync.approveImport(sourceId, 'data-scout', bundle.root);
    const manifest = bundle.files.find(row => row.path.endsWith('/data-scout.json'))!;
    internals.writeImportJournal({ 'data-scout': { source: sourceId, root: bundle.root,
      manifestHash: manifest.sha256, state: 'pending' } });
    const { loadAgentMdJobs } = await import('../../src/scheduler/AgentMdJobLoader.js');
    const result = loadAgentMdJobs(path.join(stateDir, 'jobs', 'schedule'), path.join(stateDir, 'jobs'));
    expect(result.jobs.some(job => job.slug === 'data-scout')).toBe(false);
    expect(sync.gaps()).toContainEqual(expect.stringContaining('interrupted'));
  });
  it('preserves a conflicting local dependency and leaves the job uninstalled', async () => {
    const source = fixture();
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-destination-'));
    roots.push(destination);
    const destinationState = path.join(destination, '.instar');
    fs.mkdirSync(path.join(destination, 'projects', 'data-scout'), { recursive: true });
    fs.writeFileSync(path.join(destination, 'projects', 'data-scout', 'input.txt'), 'local edit');
    const bundle = collectPortableJob(source.root, source.stateDir, 'data-scout');
    const { JobPortableSync } = await import('../../src/core/JobPortableSync.js');
    const sync = new JobPortableSync({ stateDir: destinationState, projectDir: destination,
      identityManager: null as never, authToken: '' });
    const sourceId = `m_${'1'.repeat(32)}`;
    (sync as unknown as { writeInbox: (id: string, bundle: typeof bundle) => void }).writeInbox(sourceId, bundle);
    expect(() => sync.approveImport(sourceId, 'data-scout', bundle.root)).toThrow('local-file-conflict');
    expect(fs.readFileSync(path.join(destination, 'projects', 'data-scout', 'input.txt'), 'utf8')).toBe('local edit');
    expect(fs.existsSync(path.join(destinationState, 'jobs', 'schedule', 'data-scout.json'))).toBe(false);
  });
});
