// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
// safe-git-allow: test file — `git init` / `git check-ignore` on a throwaway fixture repo (read-only ignore probes; nothing destructive).
/**
 * Key material is never served, backed up or listed — by lists the config
 * cannot loosen (docs/specs/a2a-single-agent-identity.md §5, AC7).
 *
 * Tier 1. Static: ONE source list (src/core/keyMaterialPaths.ts) feeds the
 * file routes' never-served deny, BackupManager, the gitignore entries and
 * the sync classifier, and every entry is asserted on each of the four.
 * Behavioural (express + createFileRoutes, default config allowedPaths ['./']):
 * a key file is refused by read/download/list/link — by its direct path, via a
 * symlink with an innocent name, via a HARD LINK outside .instar/ (an inode
 * no prefix check can see), and when the file is swapped between the check
 * and the open (the §5.2 descriptor proof, exercised through the exported
 * helper because the race cannot be produced deterministically over HTTP). A
 * dangling symlink is OMITTED from a listing; an allowed file is streamed from
 * the checked descriptor; `conversations.json` (the operator's own audit
 * surface) still serves; PATCH /api/files/config cannot re-admit a key file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import request from 'supertest';
import {
  createFileRoutes,
  isNeverEditable,
  isNeverServed,
  openCheckedDescriptor,
  NEVER_SERVED_PREFIXES,
} from '../../src/server/fileRoutes.js';
import {
  KEY_MATERIAL_PATHS,
  KEY_MATERIAL_FILES,
  KEY_MATERIAL_NEVER_SERVED_PREFIXES,
  KEY_MATERIAL_BACKUP_PREFIXES,
  KEY_MATERIAL_GITIGNORE_PROJECT,
  KEY_MATERIAL_GITIGNORE_STATE,
  KEY_MATERIAL_SECRET_PATTERNS,
} from '../../src/core/keyMaterialPaths.js';
import { BackupManager } from '../../src/core/BackupManager.js';
import { FileClassifier } from '../../src/core/FileClassifier.js';
import { ensureGitignore } from '../../src/core/MachineIdentity.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const CSRF = { 'x-instar-request': '1' };
const PRIVATE_KEY_MARKER = 'PRIVATE-KEY-BYTES-MUST-NEVER-LEAVE';

/** A representative path under each prefix (a file inside a directory prefix, the file itself otherwise). */
function representative(prefix: string): string {
  return prefix.endsWith('/') ? `${prefix}probe.key` : prefix;
}

/** The sibling a prefix is meant to cover (the owner-only writer's temp name / a renamed-aside copy). */
function sibling(prefix: string): string {
  return prefix.endsWith('/') ? `${prefix}nested/deep.key` : `${prefix}.superseded-2026-10-09`;
}

describe('§5.1 — one list, four surfaces (static)', () => {
  it('names every path the spec lists', () => {
    for (const p of [
      'identity.json',
      'threadline/identity.json',
      'threadline/inbox-hmac.key',
      'threadline/invitation-secret.key',
      'threadline/secure-invitations.json',
      'machine-ssh/',
      'state/inbound-delivery.hmac-key',
      'relay-tokens.json',
      'local-state/',
      'origin-sessions-',
      'state/conversation-bind-token.secret',
    ]) {
      expect(KEY_MATERIAL_PATHS, `spec §5.1 entry ${p}`).toContain(p);
    }
  });

  it('every entry is in NEVER_SERVED_PREFIXES (projectDir-relative) and refused by isNeverServed + isNeverEditable, siblings included', () => {
    for (const p of KEY_MATERIAL_NEVER_SERVED_PREFIXES) {
      expect(NEVER_SERVED_PREFIXES).toContain(p);
      expect(isNeverServed(representative(p)), representative(p)).toBe(true);
      expect(isNeverServed(sibling(p)), sibling(p)).toBe(true);
      expect(isNeverEditable(representative(p)), representative(p)).toBe(true);
      // Case-folded, like the rest of the deny list (macOS/Windows are case-insensitive).
      expect(isNeverServed(representative(p).toUpperCase()), representative(p).toUpperCase()).toBe(true);
    }
  });

  it('only the KEY files under threadline/ are denied — the audit surfaces still serve', () => {
    expect(isNeverServed('.instar/threadline/conversations.json')).toBe(false);
    expect(isNeverServed('.instar/threadline/trust-profiles.json')).toBe(false);
    expect(isNeverServed('.instar/threadline/threads/abc.jsonl')).toBe(false);
    expect(isNeverServed('.instar/threadline/invitations.json')).toBe(false);
    // Over-match guard: a file whose name merely CONTAINS a prefix is not denied.
    expect(isNeverServed('docs/identity.json')).toBe(false);
    expect(isNeverServed('.instar/identity-notes.md')).toBe(false);
  });

  it('every entry is classified never-sync by FileClassifier, siblings included', () => {
    const classifier = new FileClassifier({ projectDir: '/repo' });
    for (const p of KEY_MATERIAL_NEVER_SERVED_PREFIXES) {
      expect(classifier.classify(representative(p)).strategy, representative(p)).toBe('never-sync');
      expect(classifier.classify(sibling(p)).strategy, sibling(p)).toBe('never-sync');
    }
    expect(KEY_MATERIAL_SECRET_PATTERNS.length).toBe(KEY_MATERIAL_PATHS.length);
    expect(classifier.classify('.instar/threadline/conversations.json').strategy).not.toBe('never-sync');
  });

  it('BackupManager refuses every entry in BOTH spellings even when includeFiles names it directly', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-material-backup-'));
    try {
      const entries: string[] = [];
      for (const p of KEY_MATERIAL_PATHS) {
        const rel = representative(p);
        fs.mkdirSync(path.dirname(path.join(stateDir, rel)), { recursive: true });
        fs.writeFileSync(path.join(stateDir, rel), PRIVATE_KEY_MARKER);
        entries.push(rel, `.instar/${rel}`, sibling(p));
        fs.mkdirSync(path.dirname(path.join(stateDir, sibling(p))), { recursive: true });
        fs.writeFileSync(path.join(stateDir, sibling(p)), PRIVATE_KEY_MARKER);
      }
      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# agent');
      expect(KEY_MATERIAL_BACKUP_PREFIXES.length).toBe(KEY_MATERIAL_PATHS.length * 2);
      const warn = console.warn;
      console.warn = () => {};
      try {
        const manager = new BackupManager(stateDir, { includeFiles: ['AGENT.md', ...entries] });
        const snapshot = manager.createSnapshot('manual');
        expect(snapshot.files).toContain('AGENT.md');
        for (const e of entries) expect(snapshot.files, e).not.toContain(e);
        // Byte-scan the snapshot dir: no key bytes landed anywhere.
        const backupsDir = path.join(stateDir, 'backups');
        const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) =>
          x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]);
        for (const f of walk(backupsDir)) {
          expect(fs.readFileSync(f, 'utf8'), f).not.toContain(PRIVATE_KEY_MARKER);
        }
      } finally {
        console.warn = warn;
      }
    } finally {
      SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/file-routes-never-served-key-material.test.ts' });
    }
  });

  it('ensureGitignore writes every project entry and git honours them for the file and its siblings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-material-gitignore-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q']);
      ensureGitignore(dir);
      ensureGitignore(dir); // idempotent
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      for (const e of KEY_MATERIAL_GITIGNORE_PROJECT) {
        expect(content.split('\n').filter((l) => l.trim() === e).length, e).toBe(1);
      }
      expect(KEY_MATERIAL_GITIGNORE_STATE.map((e) => `.instar/${e}`)).toEqual([...KEY_MATERIAL_GITIGNORE_PROJECT]);
      for (const p of KEY_MATERIAL_NEVER_SERVED_PREFIXES) {
        for (const rel of [representative(p), sibling(p)]) {
          const ignored = (() => {
            try { execFileSync('git', ['-C', dir, 'check-ignore', '-q', rel]); return true; } catch { return false; }
          })();
          expect(ignored, `${rel} gitignored`).toBe(true);
        }
      }
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/file-routes-never-served-key-material.test.ts' });
    }
  });

  it('the hard-link inode list names concrete files that are all never-served', () => {
    for (const f of KEY_MATERIAL_FILES) {
      expect(f.endsWith('/'), f).toBe(false);
      expect(isNeverServed(`.instar/${f}`), f).toBe(true);
    }
  });
});

describe('§5.2 — the file routes refuse key material by path, symlink, hard link and descriptor', () => {
  let projectDir: string;
  let stateDir: string;
  let app: express.Express;
  const liveConfigCalls: Array<{ path: string; value: unknown }> = [];

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-material-routes-'));
    stateDir = path.join(projectDir, '.instar');
    // Every key file EXISTS so a 403 proves the deny, never a 404.
    for (const p of KEY_MATERIAL_PATHS) {
      const rel = representative(p);
      fs.mkdirSync(path.dirname(path.join(stateDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(stateDir, rel), `{"privateKey":"${PRIVATE_KEY_MARKER}"}`, { mode: 0o600 });
    }
    fs.writeFileSync(path.join(stateDir, 'identity.json.superseded-2026-10-09'), `{"privateKey":"${PRIVATE_KEY_MARKER}"}`, { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, 'threadline', 'conversations.json'), '{"conversations":[]}');
    fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'docs', 'readme.md'), '# hello docs\n');
    // Symlink with an innocent name → the identity file.
    fs.symlinkSync(path.join('..', '.instar', 'identity.json'), path.join(projectDir, 'docs', 'notes.md'));
    // Symlinked DIRECTORY → threadline key dir.
    fs.symlinkSync(path.join('..', '.instar', 'threadline'), path.join(projectDir, 'docs', 'tl'));
    // Dangling symlink.
    fs.symlinkSync(path.join('..', 'does-not-exist.md'), path.join(projectDir, 'docs', 'dangling.md'));
    // HARD LINK outside .instar/ carrying the identity file's inode.
    fs.linkSync(path.join(stateDir, 'identity.json'), path.join(projectDir, 'docs', 'innocent.txt'));
    // Hard link to a key the prefix list sees only through the machine dir.
    fs.linkSync(path.join(stateDir, 'machine', 'probe.key'), path.join(projectDir, 'docs', 'innocent2.txt'));

    const config = {
      projectDir,
      stateDir,
      projectName: 'key-material-test',
      port: 0,
      // DEFAULT config (allowedPaths ['./'], editablePaths ['./']) — the deny
      // must hold under the widest config.
    } as unknown as InstarConfig;

    app = express();
    app.use(express.json());
    app.use(createFileRoutes({
      config,
      liveConfig: { set: (p: string, v: unknown) => liveConfigCalls.push({ path: p, value: v }) },
    }));
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/file-routes-never-served-key-material.test.ts' });
  });

  const expectRefused = (res: request.Response, status = 403) => {
    expect(res.status).toBe(status);
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_KEY_MARKER);
    expect(res.text ?? '').not.toContain(PRIVATE_KEY_MARKER);
  };

  it('read/download/link refuse EVERY listed key file by its direct path (403, body carries no key bytes)', async () => {
    for (const p of KEY_MATERIAL_PATHS) {
      const rel = `.instar/${representative(p)}`;
      expectRefused(await request(app).get('/api/files/read').query({ path: rel }));
      expectRefused(await request(app).get('/api/files/download').query({ path: rel }));
      expectRefused(await request(app).get('/api/files/link').query({ path: rel }));
    }
    expectRefused(await request(app).get('/api/files/read').query({ path: '.instar/identity.json.superseded-2026-10-09' }));
  });

  it('list refuses a key directory and OMITS key files from a parent listing', async () => {
    expect((await request(app).get('/api/files/list').query({ path: '.instar/machine-ssh' })).status).toBe(403);
    expect((await request(app).get('/api/files/list').query({ path: '.instar/local-state' })).status).toBe(403);
    const root = await request(app).get('/api/files/list').query({ path: '.instar' });
    expect(root.status).toBe(200);
    const names = root.body.entries.map((e: { name: string }) => e.name);
    expect(names).not.toContain('identity.json');
    expect(names).not.toContain('identity.json.superseded-2026-10-09');
    expect(names).not.toContain('relay-tokens.json');
    expect(names).not.toContain('machine-ssh');
    expect(names).not.toContain('local-state');
    expect(names).not.toContain('origin-sessions-');
    expect(names).toContain('threadline'); // the dir itself is browsable
    const tl = await request(app).get('/api/files/list').query({ path: '.instar/threadline' });
    expect(tl.status).toBe(200);
    const tlNames = tl.body.entries.map((e: { name: string }) => e.name);
    expect(tlNames).toContain('conversations.json');
    for (const n of ['identity.json', 'inbox-hmac.key', 'invitation-secret.key', 'secure-invitations.json']) {
      expect(tlNames, n).not.toContain(n);
    }
  });

  it('a symlink with an innocent name is refused by read/download/link and hidden from list; a dangling symlink is omitted', async () => {
    expectRefused(await request(app).get('/api/files/read').query({ path: 'docs/notes.md' }));
    expectRefused(await request(app).get('/api/files/download').query({ path: 'docs/notes.md' }));
    expectRefused(await request(app).get('/api/files/link').query({ path: 'docs/notes.md' }));
    // Symlinked directory into the key dir: the listing itself is allowed
    // (conversations.json lives there) but the key files are omitted.
    const viaLink = await request(app).get('/api/files/list').query({ path: 'docs/tl' });
    expect(viaLink.status).toBe(200);
    expect(viaLink.body.entries.map((e: { name: string }) => e.name)).not.toContain('identity.json');
    expectRefused(await request(app).get('/api/files/read').query({ path: 'docs/tl/identity.json' }));
    const docs = await request(app).get('/api/files/list').query({ path: 'docs' });
    expect(docs.status).toBe(200);
    const names = docs.body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('readme.md');
    expect(names).not.toContain('notes.md');     // resolves into key material → hidden
    expect(names).not.toContain('dangling.md');  // realpath fails → omitted
    expect(names).toContain('tl');               // a browsable dir stays listed
    // link on the dangling symlink refuses (realpath failure), never mints.
    const dangling = await request(app).get('/api/files/link').query({ path: 'docs/dangling.md' });
    expect([403, 404]).toContain(dangling.status);
    expect(dangling.body.relative).toBeUndefined();
  });

  it('a HARD LINK outside .instar/ carrying a key inode is refused by read and download (nlink>1 + inode match)', async () => {
    // Sanity: the link really is a second name for the same inode.
    expect(fs.statSync(path.join(projectDir, 'docs', 'innocent.txt')).nlink).toBeGreaterThan(1);
    expectRefused(await request(app).get('/api/files/read').query({ path: 'docs/innocent.txt' }));
    expectRefused(await request(app).get('/api/files/download').query({ path: 'docs/innocent.txt' }));
    // The hard link's name is innocent and it lives in an allowed dir, so the
    // listing shows it — the deny is on the OPENED inode, not the name.
    const docs = await request(app).get('/api/files/list').query({ path: 'docs' });
    expect(docs.body.entries.map((e: { name: string }) => e.name)).toContain('innocent.txt');
  });

  it('a hard link whose inode is NOT a key file is still served (no over-block on nlink alone)', async () => {
    fs.linkSync(path.join(projectDir, 'docs', 'readme.md'), path.join(projectDir, 'docs', 'readme-link.md'));
    expect(fs.statSync(path.join(projectDir, 'docs', 'readme-link.md')).nlink).toBeGreaterThan(1);
    const res = await request(app).get('/api/files/read').query({ path: 'docs/readme-link.md' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# hello docs\n');
  });

  it('an allowed file is read AND downloaded from the checked descriptor (full bytes, correct length)', async () => {
    const res = await request(app).get('/api/files/read').query({ path: 'docs/readme.md' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# hello docs\n');
    expect(res.body.size).toBe(Buffer.byteLength('# hello docs\n'));
    const dl = await request(app).get('/api/files/download').query({ path: 'docs/readme.md' }).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-length']).toBe(String(Buffer.byteLength('# hello docs\n')));
    expect((dl.body as Buffer).toString('utf8')).toBe('# hello docs\n');
  });

  it('conversations.json (the operator audit surface) still serves', async () => {
    const res = await request(app).get('/api/files/read').query({ path: '.instar/threadline/conversations.json' });
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('conversations');
    const link = await request(app).get('/api/files/link').query({ path: '.instar/threadline/conversations.json' });
    expect(link.status).toBe(200);
    expect(link.body.relative).toContain('conversations.json');
  });

  it('PATCH /api/files/config cannot re-admit a never-served path (config can narrow, never loosen)', async () => {
    const patch = await request(app)
      .patch('/api/files/config')
      .set(CSRF)
      .send({ allowedPaths: ['.instar/', '.instar/threadline/'] });
    expect(patch.status).toBe(200);
    expect(patch.body.allowedPaths).toEqual(['.instar/', '.instar/threadline/']);
    expectRefused(await request(app).get('/api/files/read').query({ path: '.instar/identity.json' }));
    expectRefused(await request(app).get('/api/files/read').query({ path: '.instar/threadline/inbox-hmac.key' }));
    expectRefused(await request(app).get('/api/files/download').query({ path: '.instar/relay-tokens.json' }));
    expectRefused(await request(app).get('/api/files/link').query({ path: '.instar/state/conversation-bind-token.secret' }));
    // Restore the default so later cases see the widest config.
    await request(app).patch('/api/files/config').set(CSRF).send({ allowedPaths: ['./'] });
  });

  it('POST /api/files/save on a key file → 403 (never-editable by construction)', async () => {
    const res = await request(app)
      .post('/api/files/save')
      .set(CSRF)
      .send({ path: '.instar/identity.json', content: '{"privateKey":"poisoned"}' });
    expect(res.status).toBe(403);
    expect(fs.readFileSync(path.join(stateDir, 'identity.json'), 'utf8')).toContain(PRIVATE_KEY_MARKER);
  });

  it('openCheckedDescriptor refuses when the target is swapped between the check and the open (the §5.2 race)', async () => {
    const allowed = path.join(projectDir, 'docs', 'swap-target.md');
    fs.writeFileSync(allowed, 'harmless\n');
    const alias = path.join(projectDir, 'docs', 'alias.md');
    fs.symlinkSync('swap-target.md', alias);
    // The check: validation resolved the alias to the harmless file and took its stat.
    const checkedReal = fs.realpathSync(alias);
    const checkedStat = fs.statSync(checkedReal);
    expect(checkedReal).toBe(fs.realpathSync(allowed));
    // The swap: between the check and the open, the checked PATH now names a key file.
    fs.renameSync(allowed, allowed + '.moved');
    fs.symlinkSync(path.join('..', '.instar', 'identity.json'), allowed);
    const opened = await openCheckedDescriptor(checkedReal, checkedStat, projectDir);
    expect(opened.handle).toBeNull();
    expect((opened as { reason: string }).reason).toBe('File changed between check and open');
    // Unswapped: the same check against the real file opens and serves it.
    SafeFsExecutor.safeUnlinkSync(allowed, { operation: 'tests/unit/file-routes-never-served-key-material.test.ts' });
    fs.renameSync(allowed + '.moved', allowed);
    const ok = await openCheckedDescriptor(checkedReal, fs.statSync(checkedReal), projectDir);
    expect(ok.handle).not.toBeNull();
    if (ok.handle) {
      expect((await ok.handle.readFile()).toString('utf8')).toBe('harmless\n');
      await ok.handle.close();
    }
  });

  it('openCheckedDescriptor refuses a key inode reached by hard link, and admits an unrelated multi-link inode', async () => {
    const keyLink = path.join(projectDir, 'docs', 'innocent.txt');
    const refused = await openCheckedDescriptor(keyLink, fs.statSync(keyLink), projectDir);
    expect(refused.handle).toBeNull();
    expect((refused as { reason: string }).reason).toBe('Access to this path is not permitted');
    const plainLink = path.join(projectDir, 'docs', 'readme-link.md');
    const admitted = await openCheckedDescriptor(plainLink, fs.statSync(plainLink), projectDir);
    expect(admitted.handle).not.toBeNull();
    if (admitted.handle) await admitted.handle.close();
  });

  it('blockedFilenames is checked on the RESOLVED name too (a symlink named notes.md → .env is refused)', async () => {
    fs.writeFileSync(path.join(projectDir, '.env'), 'SECRET=1\n');
    fs.symlinkSync(path.join('..', '.env'), path.join(projectDir, 'docs', 'env-alias.md'));
    const res = await request(app).get('/api/files/read').query({ path: 'docs/env-alias.md' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('SECRET=1');
    const docs = await request(app).get('/api/files/list').query({ path: 'docs' });
    expect(docs.body.entries.map((e: { name: string }) => e.name)).not.toContain('env-alias.md');
  });
});
