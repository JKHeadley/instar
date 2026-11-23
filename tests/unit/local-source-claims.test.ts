import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { ImportedHistoryStore, importedRef, ImportWriterBusy } from '../../src/import/ImportedHistoryStore.js';
import { createLocalSourceClaim, localSourceDestination, type LocalSourceIdentity } from '../../src/import/LocalSourceIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CHUNK_BYTES } from '../../src/core/appMediaTypes.js';
import { closeAllSqlite } from '../../src/core/SqliteRegistry.js';

const privateIt = it.skipIf(process.platform === 'win32' || !process.getuid);
const dirs: string[] = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-claims-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'local source claim tests' }); });
const identity: LocalSourceIdentity = { ownerUserId: 'owner-one', source: 'codex', originalId: 'session-one',
  projectPath: '/projects/garden', representation: 'canonical', parserContractVersion: 1 };
const conversation = (destinationId: string) => ({ from: 'codex' as const, originalId: destinationId, title: 'A garden', createdAt: null,
  messages: [{ key: 'first', role: 'operator' as const, senderName: 'Me', at: null, text: 'Plan a garden' }],
  overflow: [], stats: { redactions: 0, splitMessages: 0, droppedBranches: 0 } });

privateIt('scopes destinations to stable owner and source, not device credentials or project', () => {
  const first = localSourceDestination(identity);
  expect(first).toMatch(/^local-v1-[a-f0-9]{64}$/);
  expect(first).not.toContain(identity.originalId);
  expect(localSourceDestination({ ...identity })).toBe(first);
  expect(localSourceDestination({ ...identity, ownerUserId: 'owner-two' })).not.toBe(first);
  expect(localSourceDestination({ ...identity, source: 'claude-code' })).not.toBe(first);
  expect(createLocalSourceClaim({ ...identity, projectPath: '/different' }).destinationId).toBe(first);
});

privateIt('requires an active real writer claim on every local append, including a later writer', async () => {
  const store = new ImportedHistoryStore(tmp());
  const destination = localSourceDestination(identity);
  expect(() => store.assertOrClaimLocalSource(identity)).toThrow('local-source-writer-required');
  expect(() => store.addConversation(conversation(destination))).toThrow('local-source-active-claim-required');
  await store.withWriter(async () => {
    const claim = store.assertOrClaimLocalSource(identity);
    expect(store.addConversation(conversation(claim.destinationId))).toEqual({ added: 1, isNew: true });
    store.flush();
  });
  await store.withWriter(async () => {
    expect(() => store.addConversation(conversation(destination))).toThrow('local-source-active-claim-required');
    store.assertOrClaimLocalSource(identity);
    expect(store.addConversation(conversation(destination)).added).toBe(0);
  });
});

privateIt('refuses further local mutation if teardown closes the actual writer lease during its callback', async () => {
  const store = new ImportedHistoryStore(tmp());
  await store.withWriter(async () => {
    const claim = store.assertOrClaimLocalSource(identity);
    closeAllSqlite();
    expect(() => store.assertOrClaimLocalSource(identity)).toThrow('local-source-writer-required');
    expect(() => store.addConversation(conversation(claim.destinationId))).toThrow('import-writer-lease-lost');
  });
  expect(store.listConversations()).toEqual([]);
});

privateIt('does not append archive bytes through a callback after its actual writer lease is lost', async () => {
  const store = new ImportedHistoryStore(tmp());
  await store.withWriter(async () => {
    closeAllSqlite();
    expect(() => store.addConversation({ ...conversation('archive-one'), from: 'claude' })).toThrow('import-writer-lease-lost');
    expect(() => store.addProject({ from: 'claude', originalId: 'project-one', name: 'Garden', instructions: '', fileNames: [] })).toThrow('import-writer-lease-lost');
  });
  expect(fs.readdirSync(path.join(store.dir, 'conversations'))).toEqual([]);
  expect(store.listProjects()).toEqual([]);
});

privateIt('does not lend a new same-instance writer to an old callback awaiting after teardown', async () => {
  const store = new ImportedHistoryStore(tmp());
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = store.withWriter(async () => { entered(); await waiting; });
  try {
    await ready; closeAllSqlite();
    await expect(store.withWriter(async () => undefined)).rejects.toBeInstanceOf(ImportWriterBusy);
  } finally { release(); await first; }
});

privateIt('rejects leaving local summary changes pending outside their writer and permits a fresh reconciliation', async () => {
  const dir = tmp();
  const store = new ImportedHistoryStore(dir);
  await expect(store.withWriter(async () => {
    const claim = store.assertOrClaimLocalSource(identity);
    store.addConversation(conversation(claim.destinationId));
  })).rejects.toThrow('local-source-flush-required');
  expect(store.listConversations()).toEqual([]);
  const reopened = new ImportedHistoryStore(dir);
  await reopened.withWriter(async () => {
    const claim = reopened.assertOrClaimLocalSource(identity);
    expect(reopened.addConversation(conversation(claim.destinationId)).added).toBe(0);
    reopened.flush();
  });
  expect(reopened.listConversations()[0]?.messageCount).toBe(1);
});

privateIt('retains the claim before append and permits a same-mode retry after reopening', async () => {
  const dir = tmp();
  const store = new ImportedHistoryStore(dir);
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  expect(store.listConversations()).toEqual([]);
  const reopened = new ImportedHistoryStore(dir);
  expect(reopened.readLocalSourceClaim(identity)).toEqual(createLocalSourceClaim(identity));
  expect(reopened.readLocalSourceClaim({ ...identity, ownerUserId: 'owner-two' })).toBeNull();
  await reopened.withWriter(async () => {
    const claim = reopened.assertOrClaimLocalSource(identity);
    reopened.addConversation(conversation(claim.destinationId)); reopened.flush();
  });
  expect(reopened.listConversations()).toHaveLength(1);
});

privateIt('refuses an orphan destination even when a valid claim database already exists', async () => {
  const dir = tmp();
  const store = new ImportedHistoryStore(dir);
  const unrelated = { ...identity, originalId: 'another-session' };
  await store.withWriter(async () => { store.assertOrClaimLocalSource(unrelated); });
  const destination = localSourceDestination(identity);
  const ref = importedRef(identity.source, destination);
  const file = crypto.createHash('sha256').update(ref).digest('hex').slice(0, 32);
  const orphanFile = path.join(store.dir, 'conversations', file + '.jsonl');
  const bytes = JSON.stringify(conversation(destination).messages[0]) + '\n';
  fs.writeFileSync(orphanFile, bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(store.dir, 'manifest.json'), JSON.stringify({ version: 1, projects: {}, conversations: {
    [ref]: { ref, from: identity.source, originalId: destination, title: 'Orphan', createdAt: null, lastAt: null, messageCount: 1, file, hash: 'synthetic' },
  } }), { flag: 'wx', mode: 0o600 });
  const reopened = new ImportedHistoryStore(dir);
  expect(() => reopened.readLocalSourceClaim(identity)).toThrow('unknown-source-identity');
  await expect(reopened.withWriter(async () => { reopened.assertOrClaimLocalSource(identity); })).rejects.toThrow('unknown-source-identity');
  expect(fs.readFileSync(orphanFile, 'utf8')).toBe(bytes);
  expect(reopened.readLocalSourceClaim(unrelated)).toEqual(createLocalSourceClaim(unrelated));
});

privateIt.each([
  { parserContractVersion: 2 as 1 }, { representation: 'claude-records' as const },
  { ownerUserId: '' }, { source: 'claude-code' as const, representation: 'canonical' as const },
])('refuses unsupported source provenance before creating claim storage %j', async change => {
  const store = new ImportedHistoryStore(tmp());
  await expect(store.withWriter(async () => { store.assertOrClaimLocalSource({ ...identity, ...change }); })).rejects.toThrow('local-source-identity-invalid');
  expect(fs.existsSync(path.join(store.dir, 'source-claims.sqlite'))).toBe(false);
  expect(store.listConversations()).toEqual([]);
});

privateIt.each([
  { projectPath: '/another-project' }, { representation: 'event-fallback' as const },
])('requires reconciliation for conflicting durable provenance %j', async change => {
  const store = new ImportedHistoryStore(tmp());
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  await expect(store.withWriter(async () => { store.assertOrClaimLocalSource({ ...identity, ...change }); })).rejects.toThrow('local-source-reconciliation-required');
  expect(store.listConversations()).toEqual([]);
});

privateIt('refuses existing owner-scoped local content without a claim instead of inventing its owner or parser mode', async () => {
  const dir = tmp();
  const store = new ImportedHistoryStore(dir);
  const destination = localSourceDestination(identity);
  const ref = importedRef(identity.source, destination);
  const file = crypto.createHash('sha256').update(ref).digest('hex').slice(0, 32);
  fs.writeFileSync(path.join(store.dir, 'conversations', file + '.jsonl'), JSON.stringify(conversation(destination).messages[0]) + '\n', { mode: 0o600 });
  expect(() => store.readLocalSourceClaim(identity)).toThrow('unknown-source-identity');
  await expect(store.withWriter(async () => { store.assertOrClaimLocalSource(identity); })).rejects.toThrow('unknown-source-identity');
  expect(fs.existsSync(path.join(store.dir, 'source-claims.sqlite'))).toBe(false);
});

privateIt('does not probe, claim or merge an unscoped legacy record when copying to the actual owner destination', async () => {
  const dir = tmp();
  let store = new ImportedHistoryStore(dir);
  const ref = importedRef(identity.source, identity.originalId);
  const file = crypto.createHash('sha256').update(ref).digest('hex').slice(0, 32);
  const legacyFile = path.join(store.dir, 'conversations', file + '.jsonl');
  const legacy = JSON.stringify({ ...conversation('old').messages[0], text: 'UNASSIGNED LEGACY CONTENT' }) + '\n';
  fs.writeFileSync(legacyFile, legacy, { mode: 0o600 });
  fs.writeFileSync(path.join(store.dir, 'manifest.json'), JSON.stringify({ version: 1, projects: {}, conversations: {
    [ref]: { ref, from: identity.source, originalId: identity.originalId, title: 'Unassigned', createdAt: null, lastAt: null, messageCount: 1, file, hash: 'synthetic' },
  } }), { mode: 0o600 });
  store = new ImportedHistoryStore(dir);
  expect(store.readLocalSourceClaim(identity)).toBeNull();
  await store.withWriter(async () => {
    const claim = store.assertOrClaimLocalSource(identity);
    expect(store.addConversation(conversation(claim.destinationId))).toEqual({ added: 1, isNew: true });
    store.flush();
  });
  expect(fs.readFileSync(legacyFile, 'utf8')).toBe(legacy);
  expect(store.readMessages(importedRef(identity.source, localSourceDestination(identity)))?.map(m => m.text)).toEqual(['Plan a garden']);
  expect(store.listConversations('exports')).toEqual([]);
  const db = new Database(path.join(store.dir, 'source-claims.sqlite'), { readonly: true });
  try { expect(db.prepare('SELECT ref FROM local_source_claims WHERE ref = ?').get(ref)).toBeUndefined(); } finally { db.close(); }
});

privateIt('keeps two actual owner profiles separate even when session and message identifiers match', async () => {
  const store = new ImportedHistoryStore(tmp());
  const refs: string[] = [];
  await store.withWriter(async () => {
    for (const ownerUserId of ['owner-one', 'owner-two']) {
      const claim = store.assertOrClaimLocalSource({ ...identity, ownerUserId });
      expect(store.addConversation(conversation(claim.destinationId)).added).toBe(1);
      refs.push(importedRef(claim.source, claim.destinationId));
    }
    store.flush();
  });
  expect(new Set(refs).size).toBe(2);
  expect(refs.map(ref => store.readMessages(ref)?.length)).toEqual([1, 1]);
  expect(store.listConversations('exports')).toEqual([]);
});

privateIt('accepts Claude Code records with their own durable representation', async () => {
  const store = new ImportedHistoryStore(tmp());
  const source: LocalSourceIdentity = { ...identity, source: 'claude-code', representation: 'claude-records' };
  await store.withWriter(async () => {
    const claim = store.assertOrClaimLocalSource(source);
    expect(store.addConversation({ ...conversation(claim.destinationId), from: 'claude-code' }).added).toBe(1);
    store.flush();
  });
  expect(store.readLocalSourceClaim(source)).toEqual(createLocalSourceClaim(source));
});

privateIt.each(['json', 'version', 'parser-version', 'mode', 'owner', 'destination', 'misbound-owner', 'oversized'])('refuses damaged or forged durable metadata %s after reopening without changing conversation bytes', async damage => {
  const dir = tmp();
  const store = new ImportedHistoryStore(dir);
  const claim = createLocalSourceClaim(identity);
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity); store.addConversation(conversation(claim.destinationId)); store.flush();
  });
  const ref = importedRef(claim.source, claim.destinationId);
  const conversationFile = path.join(store.dir, 'conversations', crypto.createHash('sha256').update(ref).digest('hex').slice(0, 32) + '.jsonl');
  const before = fs.readFileSync(conversationFile);
  const values: Record<string, string> = {
    json: '{', version: JSON.stringify({ ...claim, version: 2 }),
    'parser-version': JSON.stringify({ ...claim, parserContractVersion: 2 }),
    mode: JSON.stringify({ ...claim, representation: 'unknown-mode' }),
    owner: JSON.stringify({ ...claim, ownerUserId: 'owner-two' }),
    destination: JSON.stringify({ ...claim, destinationId: 'local-v1-' + '0'.repeat(64) }),
    'misbound-owner': JSON.stringify(createLocalSourceClaim({ ...identity, ownerUserId: 'owner-two' })),
    oversized: ' '.repeat(CHUNK_BYTES + 1),
  };
  const db = new Database(path.join(store.dir, 'source-claims.sqlite'));
  try { db.prepare('UPDATE local_source_claims SET payload = ? WHERE ref = ?').run(values[damage], ref); } finally { db.close(); }
  const reopened = new ImportedHistoryStore(dir);
  expect(() => reopened.readLocalSourceClaim(identity)).toThrow('unknown-source-identity');
  await expect(reopened.withWriter(async () => { reopened.assertOrClaimLocalSource(identity); })).rejects.toThrow();
  expect(fs.readFileSync(conversationFile)).toEqual(before);
});

privateIt('rejects changed durable claims again immediately before append', async () => {
  const store = new ImportedHistoryStore(tmp());
  await store.withWriter(async () => {
    const claim = store.assertOrClaimLocalSource(identity);
    const db = new Database(path.join(store.dir, 'source-claims.sqlite'));
    try { db.prepare('UPDATE local_source_claims SET payload = ?').run(JSON.stringify(createLocalSourceClaim({ ...identity, projectPath: '/changed' }))); } finally { db.close(); }
    expect(() => store.addConversation(conversation(claim.destinationId))).toThrow('unknown-source-identity');
  });
  expect(store.listConversations()).toEqual([]);
});

privateIt('does not create claim storage on a read, or repair file permissions through a read', async () => {
  const store = new ImportedHistoryStore(tmp());
  expect(store.readLocalSourceClaim(identity)).toBeNull();
  const file = path.join(store.dir, 'source-claims.sqlite');
  expect(fs.existsSync(file)).toBe(false);
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  fs.chmodSync(file, 0o644);
  expect(() => store.readLocalSourceClaim(identity)).toThrow('local-source-identity-unavailable');
  expect(fs.statSync(file).mode & 0o777).toBe(0o644);
});

privateIt('allows fresh preparation after a crash leaves a valid empty claims file before schema creation', async () => {
  const store = new ImportedHistoryStore(tmp());
  const file = path.join(store.dir, 'source-claims.sqlite');
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  expect(store.readLocalSourceClaim(identity)).toBeNull();
  expect(fs.statSync(file).size).toBe(0);
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  expect(store.readLocalSourceClaim(identity)).toEqual(createLocalSourceClaim(identity));
});

privateIt.each(['other-table', 'lookalike-prefix', 'wrong-columns', 'future-version'])('refuses unexpected claim schema %s without adding provenance', async kind => {
  const store = new ImportedHistoryStore(tmp());
  const file = path.join(store.dir, 'source-claims.sqlite');
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  const db = new Database(file);
  try {
    if (kind === 'future-version') db.pragma('user_version = 2');
    else if (kind === 'wrong-columns') db.exec('CREATE TABLE local_source_claims (payload TEXT)');
    else {
      db.exec('CREATE TABLE local_source_claims (ref TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)');
      db.exec(kind === 'lookalike-prefix' ? 'CREATE TABLE sqliteevil (value TEXT)' : 'CREATE TABLE other_data (value TEXT)');
    }
  } finally { db.close(); }
  expect(() => store.readLocalSourceClaim(identity)).toThrow('unknown-source-identity');
  await expect(store.withWriter(async () => { store.assertOrClaimLocalSource(identity); })).rejects.toThrow('unknown-source-identity');
  expect(store.listConversations()).toEqual([]);
});

privateIt('does not initialize an empty claims DB over existing owner-scoped conversation bytes', async () => {
  const store = new ImportedHistoryStore(tmp());
  const file = path.join(store.dir, 'source-claims.sqlite');
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  const ref = importedRef(identity.source, localSourceDestination(identity));
  const id = crypto.createHash('sha256').update(ref).digest('hex').slice(0, 32);
  const body = JSON.stringify(conversation('old').messages[0]) + '\n';
  const target = path.join(store.dir, 'conversations', id + '.jsonl');
  fs.writeFileSync(target, body, { flag: 'wx', mode: 0o600 });
  expect(() => store.readLocalSourceClaim(identity)).toThrow('unknown-source-identity');
  await expect(store.withWriter(async () => { store.assertOrClaimLocalSource(identity); })).rejects.toThrow('unknown-source-identity');
  expect(fs.statSync(file).size).toBe(0);
  expect(fs.readFileSync(target, 'utf8')).toBe(body);
});

privateIt('recovers a killed append before the manifest save without duplicating any message', async () => {
  const dir = tmp();
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../dist/import/ImportedHistoryStore.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { ImportedHistoryStore } from ${JSON.stringify(moduleUrl)};
    const store = new ImportedHistoryStore(process.argv[1]);
    await store.withWriter(async () => {
      const claim = store.assertOrClaimLocalSource(${JSON.stringify(identity)});
      store.addConversation({ ...${JSON.stringify(conversation('placeholder'))}, originalId: claim.destinationId });
      process.send('appended-without-manifest');
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    });
  `, dir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH } });
  const exited = once(child, 'exit');
  try {
    const [ready] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('claim child exited before append'); })]);
    expect(ready).toBe('appended-without-manifest');
    child.kill('SIGKILL'); await exited;
    const reopened = new ImportedHistoryStore(dir);
    expect(reopened.listConversations()).toEqual([]);
    expect(reopened.readLocalSourceClaim(identity)).toEqual(createLocalSourceClaim(identity));
    await reopened.withWriter(async () => {
      const claim = reopened.assertOrClaimLocalSource(identity);
      const next = conversation(claim.destinationId);
      next.messages.push({ ...next.messages[0]!, key: 'second', text: 'Choose flowers' });
      expect(reopened.addConversation(next)).toEqual({ added: 1, isNew: false });
      reopened.flush();
    });
    const ref = importedRef(identity.source, localSourceDestination(identity));
    expect(reopened.readMessages(ref)?.map(message => message.key)).toEqual(['first', 'second']);
    expect(reopened.listConversations()[0]?.messageCount).toBe(2);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});

privateIt('bounds native memory while refusing a damaged oversized metadata cell', async () => {
  const dir = tmp();
  const store = new ImportedHistoryStore(dir);
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  const db = new Database(path.join(store.dir, 'source-claims.sqlite'));
  try { db.prepare('UPDATE local_source_claims SET payload = zeroblob(?)').run(64 * 1024 * 1024); } finally { db.close(); }
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../dist/import/ImportedHistoryStore.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { ImportedHistoryStore } from ${JSON.stringify(moduleUrl)};
    const store = new ImportedHistoryStore(process.argv[1]);
    const before = process.resourceUsage().maxRSS;
    let error;
    try { store.readLocalSourceClaim(${JSON.stringify(identity)}); } catch (e) { error = e.message; }
    process.send({ error, peakGrowthKiB: process.resourceUsage().maxRSS - before });
  `, dir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH } });
  const exited = once(child, 'exit');
  try {
    const [result] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('bounded-read child exited without a result'); })]) as [{error: string; peakGrowthKiB: number}];
    expect(result.error).toBe('unknown-source-identity');
    expect(result.peakGrowthKiB).toBeLessThan(32 * 1024);
    expect((await exited)[0]).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});

privateIt('recovers an interrupted claim transaction before the fresh preparation lookup', async () => {
  const dir = tmp();
  const store = new ImportedHistoryStore(dir);
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  const file = path.join(store.dir, 'source-claims.sqlite');
  const sqliteUrl = pathToFileURL(path.resolve(__dirname, '../../node_modules/better-sqlite3/lib/index.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import Database from ${JSON.stringify(sqliteUrl)};
    const db = new Database(process.argv[1]);
    db.pragma('cache_size = 1'); db.pragma('cache_spill = ON');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO local_source_claims (ref, payload) VALUES (?, zeroblob(?))').run('uncommitted', 1024 * 1024);
    process.send('uncommitted-spill');
    setInterval(() => {}, 1000);
  `, file], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH } });
  const exited = once(child, 'exit');
  try {
    const [ready] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('journal child exited before spill'); })]);
    expect(ready).toBe('uncommitted-spill');
    try { expect(store.readLocalSourceClaim(identity)).toEqual(createLocalSourceClaim(identity)); }
    catch (error) { expect(error).toBeInstanceOf(ImportWriterBusy); }
    child.kill('SIGKILL'); await exited;
    expect(fs.existsSync(file + '-journal')).toBe(true);
    expect(fs.readFileSync(file + '-journal').subarray(0, 8).some(byte => byte !== 0)).toBe(true);
    const reopened = new ImportedHistoryStore(dir);
    expect(reopened.readLocalSourceClaim(identity)).toEqual(createLocalSourceClaim(identity));
    await reopened.withWriter(async () => { expect(reopened.assertOrClaimLocalSource(identity)).toEqual(createLocalSourceClaim(identity)); });
    const db = new Database(file, { readonly: true });
    try { expect(db.prepare('SELECT ref FROM local_source_claims WHERE ref = ?').get('uncommitted')).toBeUndefined(); } finally { db.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});
