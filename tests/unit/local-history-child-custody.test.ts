import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { acquireLocalHistoryChild, holdLocalHistoryChild } from '../../src/import/LocalHistoryChildCustody.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const privateIt = it.skipIf(process.platform === 'win32' || !process.getuid);
const dirs: string[] = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-child-custody-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'local child custody test' }); });

privateIt('shares one lane across parent and child holders and refuses stale late-start generations', () => {
  const dir = tmp();
  const parent = acquireLocalHistoryChild(dir)!;
  expect(parent).not.toBeNull();
  const token = parent.custody;
  const child = holdLocalHistoryChild(token);
  expect(acquireLocalHistoryChild(dir)).toBeNull();
  parent.release();
  expect(acquireLocalHistoryChild(dir)).toBeNull();
  child.close();
  const next = acquireLocalHistoryChild(dir)!;
  expect(next.custody.generation).not.toBe(token.generation);
  expect(() => holdLocalHistoryChild(token)).toThrow('custody-stale');
  next.release();
});

privateIt('keeps another destination independent and fails closed after explicit holder close', () => {
  const first = acquireLocalHistoryChild(tmp())!;
  const other = acquireLocalHistoryChild(tmp())!;
  const hold = holdLocalHistoryChild(first.custody);
  expect(hold.active()).toBe(true);
  hold.close();
  expect(hold.active()).toBe(false);
  first.release(); other.release();
});

privateIt('refuses redirected custody database files before modifying their target', () => {
  const dir = tmp(); const target = path.join(tmp(), 'untouched');
  fs.writeFileSync(target, 'synthetic untouched');
  const root = path.join(dir, 'local-history-upload'); fs.mkdirSync(root, { mode: 0o700 });
  fs.symlinkSync(target, path.join(root, 'child-custody.sqlite'));
  expect(() => acquireLocalHistoryChild(dir)).toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe('synthetic untouched');
});

privateIt('does not reclaim a killed parent’s lane while its real orphan child still holds custody', async () => {
  const dir = tmp();
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../dist/import/LocalHistoryChildCustody.js')).href;
  const childCode = `import {holdLocalHistoryChild} from ${JSON.stringify(moduleUrl)};
    const holder=holdLocalHistoryChild(JSON.parse(process.argv[1]));
    process.send('held'); setInterval(()=>{},1000);`;
  const parentCode = `import {acquireLocalHistoryChild} from ${JSON.stringify(moduleUrl)};
    import {spawn} from 'node:child_process';
    const lease=acquireLocalHistoryChild(process.argv[1]);
    const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(childCode)},JSON.stringify(lease.custody)],{stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',()=>process.send({pid:child.pid}));
    setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', parentCode, dir], { stdio: ['ignore','ignore','ignore','ipc'] });
  const exited = once(parent, 'exit'); let orphan = 0;
  try {
    const [message] = await Promise.race([once(parent,'message'),exited.then(()=>{throw new Error('parent exited early');})]);
    orphan = message.pid;
    expect(acquireLocalHistoryChild(dir)).toBeNull();
    parent.kill('SIGKILL'); await exited;
    expect(acquireLocalHistoryChild(dir)).toBeNull();
    process.kill(orphan,'SIGKILL');
    let recovered: ReturnType<typeof acquireLocalHistoryChild> = null;
    const end = Date.now()+5000;
    while (!recovered && Date.now()<end) { await new Promise(r=>setTimeout(r,10)); recovered=acquireLocalHistoryChild(dir); }
    expect(recovered).not.toBeNull(); recovered?.release();
  } finally {
    if (parent.exitCode===null && parent.signalCode===null) {parent.kill('SIGKILL');await exited;}
    if (orphan) {try {process.kill(orphan,'SIGKILL');} catch { /* already exited */ }}
  }
});

privateIt('refuses WAL custody because readers would not exclude a replacement writer', () => {
  const dir = tmp(); const initial = acquireLocalHistoryChild(dir)!; initial.release();
  const db = new Database(path.join(dir, 'local-history-upload', 'child-custody.sqlite'));
  db.pragma('journal_mode = WAL'); db.close();
  const check = new Database(path.join(dir, 'local-history-upload', 'child-custody.sqlite'));
  const generation = check.prepare('SELECT generation FROM custody WHERE id = 1').get(); check.close();
  expect(() => acquireLocalHistoryChild(dir)).toThrow('custody-journal-mode');
  const after = new Database(path.join(dir, 'local-history-upload', 'child-custody.sqlite'));
  expect(after.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(after.prepare('SELECT generation FROM custody WHERE id = 1').get()).toEqual(generation); after.close();
});

privateIt('never creates storage for a child whose parent run has disappeared', () => {
  const dir = tmp();
  expect(() => holdLocalHistoryChild({ stateDir: dir, generation: 'a'.repeat(64) })).toThrow();
  expect(fs.readdirSync(dir)).toEqual([]);
});
