import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ImportedHistoryStore, importedRef } from '../../src/import/ImportedHistoryStore.js';
import { localSourceDestination, type LocalSourceIdentity } from '../../src/import/LocalSourceIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
  recursive: true, force: true, operation: 'local history preview fixtures',
}); });
const identity: LocalSourceIdentity = { ownerUserId: 'synthetic-owner', source: 'codex', originalId: 'synthetic-session',
  projectPath: '/synthetic/project', representation: 'canonical', parserContractVersion: 1 };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-preview-')); dirs.push(dir);
  const store = new ImportedHistoryStore(dir);
  const ref = importedRef(identity.source, localSourceDestination(identity));
  const file = path.join(store.dir, 'conversations', crypto.createHash('sha256').update(ref).digest('hex').slice(0, 32) + '.jsonl');
  return { dir, store, file };
}
it('requires an actual writer and reads an unclaimed destination without claiming it', async () => {
  const { store } = fixture();
  expect(() => store.inspectLocalDestination(identity)).toThrow('local-source-writer-required');
  await store.withWriter(async () => {
    const result = store.inspectLocalDestination(identity);
    expect(result.claim).toBeNull(); expect(result.knownMessageKeys.size).toBe(0);
    expect(fs.existsSync(path.join(store.dir, 'source-claims.sqlite'))).toBe(false);
  });
});
it('finds durable message keys even when the manifest has never been written', async () => {
  const { store, file } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  fs.writeFileSync(file, JSON.stringify({ key: 'already-copied' }) + '\n', { mode: 0o600 });
  await store.withWriter(async () => {
    const result = store.inspectLocalDestination(identity);
    expect([...result.knownMessageKeys]).toEqual(['already-copied']);
    expect(result.claim?.ownerUserId).toBe(identity.ownerUserId);
  });
  expect(fs.existsSync(path.join(store.dir, 'manifest.json'))).toBe(false);
});
it.skipIf(process.platform === 'win32')('refuses a symlink in place of the canonical destination', async () => {
  const { store, file, dir } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  const foreign = path.join(dir, 'foreign'); fs.writeFileSync(foreign, '{"key":"foreign"}\n', { mode: 0o600 });
  fs.symlinkSync(foreign, file);
  await store.withWriter(async () => { expect(() => store.inspectLocalDestination(identity)).toThrow(); });
  expect(fs.readFileSync(foreign, 'utf8')).toBe('{"key":"foreign"}\n');
});
it.skipIf(process.platform === 'win32')('refuses a hardlinked canonical destination', async () => {
  const { store, file, dir } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  const foreign = path.join(dir, 'foreign'); fs.writeFileSync(foreign, '{"key":"foreign"}\n', { mode: 0o600 });
  fs.linkSync(foreign, file);
  await store.withWriter(async () => { expect(() => store.inspectLocalDestination(identity)).toThrow('import-write-file-untrusted'); });
});
it.each([Buffer.from('{broken}\n'), Buffer.from([123, 34, 107, 101, 121, 34, 58, 34, 255, 34, 125, 10])])(
  'refuses damaged complete rows and invalid UTF8 in a claimed destination', async bytes => {
    const { store, file } = fixture();
    await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    await store.withWriter(async () => { expect(() => store.inspectLocalDestination(identity)).toThrow(); });
  });
it('preserves valid keys before a torn unterminated final record', async () => {
  const { store, file } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  fs.writeFileSync(file, '{"key":"complete"}\n{"key":', { mode: 0o600 });
  await store.withWriter(async () => { expect([...store.inspectLocalDestination(identity).knownMessageKeys]).toEqual(['complete']); });
});
it.each(['file', 'directory', 'missing'] as const)('refuses a %s replacement while reading the canonical destination', async replacement => {
  const { store, file } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  fs.writeFileSync(file, '{"key":"old"}\n', { mode: 0o600 });
  const original = fs.readFileSync;
  await store.withWriter(async () => {
    let replaced = false;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const result = original(...args);
      if (typeof args[0] === 'number' && !replaced) {
        replaced = true;
        if (replacement === 'directory') {
          fs.renameSync(path.dirname(file), path.dirname(file) + '-old');
          fs.mkdirSync(path.dirname(file), { mode: 0o700 });
        } else fs.renameSync(file, file + '.old');
        if (replacement !== 'missing') fs.writeFileSync(file, '{"key":"new"}\n', { mode: 0o600 });
      }
      return result;
    }) as typeof fs.readFileSync);
    try { expect(() => store.inspectLocalDestination(identity)).toThrow(); expect(replaced).toBe(true); }
    finally { spy.mockRestore(); }
  });
});
it('refuses an empty directory substituted immediately before opening a claimed destination', async () => {
  const { store, file } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  fs.writeFileSync(file, '{"key":"old"}\n', { mode: 0o600 });
  const original = fs.openSync;
  await store.withWriter(async () => {
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === file) {
        fs.renameSync(path.dirname(file), path.dirname(file) + '-old');
        fs.mkdirSync(path.dirname(file), { mode: 0o700 });
      }
      return original(...args);
    }) as typeof fs.openSync);
    try { expect(() => store.inspectLocalDestination(identity)).toThrow('import-read-file-changed'); }
    finally { spy.mockRestore(); }
  });
});
