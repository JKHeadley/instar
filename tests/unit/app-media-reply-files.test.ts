/**
 * The checks on a file an agent attaches to an app reply (docs/specs/mobile-native-chat-media.md
 * §4.6): confinement, the credential denylist, one checked open, limits, the snapshot and the
 * existing live-credential wall. Both sides of each decision.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConversationStore } from '../../src/core/AppConversationStore.js';
import { AppMediaStore } from '../../src/core/AppMediaStore.js';
import { confineReplyPath, discardPrepared, isCredentialPath, prepareReplyFiles, type PreparedReplyFiles } from '../../src/core/appMediaReplyFiles.js';
import { detectOutboundCredential } from '../../src/messaging/outbound-credential-guard.js';
import { isNeverServed } from '../../src/server/fileRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-media-reply-files.test.ts' }); });

// A fake but well-formed key: assembled here so this file holds no credential-shaped literal.
const LIVE_KEY = ['ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');

function setup(max = 1e9) {
  const parent = fs.mkdtempSync(path.join(process.env.HOME ?? os.homedir(), '.mreply-'));
  dirs.push(parent);
  const projectDir = path.join(parent, 'project');
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const store = new AppConversationStore({ stateDir, machineId: () => 'm1' });
  const media = new AppMediaStore({ stateDir, store, maxStoreBytes: () => max, diskSpace: () => ({ free: 1e12, total: 2e12 }) });
  const roots = { projectDir, outboxDir: media.outboxDir };
  const prep = (files: string[]) => prepareReplyFiles(media, files, roots, isNeverServed, detectOutboundCredential);
  const file = (rel: string, content: string | Buffer) => { const p = path.join(projectDir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
  return { parent, projectDir, stateDir, media, roots, prep, file };
}

describe('confinement', () => {
  it('allows a project file, an outbox file and a temporary file', () => {
    const e = setup();
    expect('real' in confineReplyPath(e.file('report.pdf', 'x'), e.roots, isNeverServed)).toBe(true);
    const out = path.join(e.media.outboxDir, 'r.txt');
    fs.writeFileSync(out, 'x');
    expect('real' in confineReplyPath(out, e.roots, isNeverServed)).toBe(true);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mreply-'));
    dirs.push(tmp);
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
    expect('real' in confineReplyPath(path.join(tmp, 'a.txt'), e.roots, isNeverServed)).toBe(true);
  });

  it('refuses outside the three roots, a relative path, and a missing file', () => {
    const e = setup();
    fs.writeFileSync(path.join(e.parent, 'outside.txt'), 'x');
    expect(confineReplyPath(path.join(e.parent, 'outside.txt'), e.roots, isNeverServed)).toMatchObject({ status: 403, error: 'path-not-allowed' });
    expect(confineReplyPath('report.pdf', e.roots, isNeverServed)).toMatchObject({ error: 'path-not-allowed' });
    expect(confineReplyPath(path.join(e.projectDir, 'nope'), e.roots, isNeverServed)).toMatchObject({ status: 404 });
  });

  it('a symlink from the temporary directory to outside is judged by where it leads', () => {
    const e = setup();
    fs.writeFileSync(path.join(e.parent, 'id_ed25519'), 'secret');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mreply-'));
    dirs.push(tmp);
    fs.symlinkSync(path.join(e.parent, 'id_ed25519'), path.join(tmp, 'link'));
    expect(confineReplyPath(path.join(tmp, 'link'), e.roots, isNeverServed)).toMatchObject({ error: 'path-not-allowed' });
  });

  it('refuses this agent\'s state, sign-in folders and home credentials inside an allowed root', () => {
    const e = setup();
    expect(confineReplyPath(e.file('.instar/config.json', '{}'), e.roots, isNeverServed)).toMatchObject({ error: 'key-material' });
    expect(confineReplyPath(e.file('.claude/.credentials.json', '{}'), e.roots, isNeverServed)).toMatchObject({ error: 'key-material' });
    expect(confineReplyPath(e.file('.codex/auth.json', '{}'), e.roots, isNeverServed)).toMatchObject({ error: 'key-material' });
    expect(confineReplyPath(e.file('sub/.ssh/id_ed25519', 'x'), e.roots, isNeverServed)).toMatchObject({ error: 'key-material' });
  });

  it('matches credential paths by component, not by substring', () => {
    expect(isCredentialPath('.aws/credentials')).toBe(true);
    expect(isCredentialPath('.config/gh/hosts.yml')).toBe(true);
    expect(isCredentialPath('.docker/config.json')).toBe(true);
    expect(isCredentialPath('Library/Keychains/login.keychain-db')).toBe(true);
    expect(isCredentialPath('notes.ssh.txt')).toBe(false);
    expect(isCredentialPath('.config/other/hosts.yml')).toBe(false);
    expect(isCredentialPath('docs/aws/guide.md')).toBe(false);
  });
});

describe('prepareReplyFiles', () => {
  const ok = (r: unknown): PreparedReplyFiles => { expect(r).toHaveProperty('snapshots'); return r as PreparedReplyFiles; };

  it('snapshots a file: a later change to the source cannot reach what was scanned', async () => {
    const e = setup();
    const src = e.file('report.txt', 'first content that is long enough');
    const r = ok(await e.prep([src]));
    fs.writeFileSync(src, LIVE_KEY);
    expect(fs.readFileSync(r.snapshots[0]!.snapshotPath, 'utf8')).toBe('first content that is long enough');
    expect(fs.statSync(r.snapshots[0]!.snapshotPath).mode & 0o777).toBe(0o400);
    discardPrepared(e.media, r);
    expect(e.media.reservedBytes()).toBe(0);
  });

  it('a hard-linked file is refused', async () => {
    const e = setup();
    const src = e.file('a.txt', 'hello');
    fs.linkSync(src, path.join(e.projectDir, 'b.txt'));
    expect(await e.prep([src])).toMatchObject({ status: 403, error: 'hard-link' });
  });

  it('the credential wall finds a key in a text file', async () => {
    const e = setup();
    expect(await e.prep([e.file('notes.txt', `token is ${LIVE_KEY} ok`)])).toMatchObject({ status: 422, error: 'credential-exposure-guard' });
    expect(e.media.reservedBytes()).toBe(0);
  });

  it('the credential wall finds a key inside a binary file through its printable runs', async () => {
    const e = setup();
    const bin = Buffer.concat([Buffer.from([0, 1, 2, 0xff]), Buffer.from(LIVE_KEY), Buffer.from([0, 0, 0xfe])]);
    expect(await e.prep([e.file('data.bin', bin)])).toMatchObject({ status: 422 });
  });

  it('a credential in a file name is refused', async () => {
    const e = setup();
    expect(await e.prep([e.file(`${LIVE_KEY}.txt`, 'harmless content here')])).toMatchObject({ status: 422, error: 'credential-exposure-guard' });
    expect(e.media.reservedBytes()).toBe(0);
  });

  it('an ordinary binary with prose passes', async () => {
    const e = setup();
    const bin = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('the password requirements are listed here'), Buffer.from([0xff])]);
    ok(await e.prep([e.file('data.bin', bin)]));
  });

  it('refuses over the limits before copying, and at the store cap', async () => {
    const e = setup(10);
    expect(await e.prep([e.file('big.txt', 'x'.repeat(100))])).toMatchObject({ status: 507, error: 'media-store-full' });
    const e2 = setup();
    const many = Array.from({ length: 11 }, (_, i) => e2.file(`f${i}.txt`, 'x'));
    expect(await e2.prep(many)).toMatchObject({ status: 413, error: 'too-many-files' });
    const huge = path.join(e2.projectDir, 'huge.bin');
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, 50 * 1024 * 1024 + 1);
    expect(await e2.prep([huge])).toMatchObject({ status: 413, error: 'file-too-large' });
  });

  it('a refusal of one file releases everything taken for the others', async () => {
    const e = setup();
    const r = await e.prep([e.file('a.txt', 'hello there'), e.file('b.txt', LIVE_KEY)]);
    expect(r).toMatchObject({ status: 422 });
    expect(e.media.reservedBytes()).toBe(0);
    expect(fs.readdirSync(path.join(e.media.root, 'uploads')).filter((n) => n.startsWith('reply-'))).toEqual([]);
  });
});
