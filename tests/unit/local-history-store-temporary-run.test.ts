import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  acquireLocalHistoryStoreTemporaryAdmission, initializeLocalHistoryStoreTemporaryRuns,
  openLocalHistoryStoreTemporaryRun, recoverLocalHistoryStoreTemporaryRuns, registerLocalHistoryStoreTemporaryRun,
  assertLocalHistoryStoreTemporaryAllocator, settleOldLocalHistoryTemporaryRuns,
  type LocalHistoryStoreTemporaryToken,
} from '../../src/import/LocalHistoryStoreTemporaryRun.js';
import { acquireLocalHistoryChild, type LocalHistoryChildAdmission } from '../../src/import/LocalHistoryChildCustody.js';
import { privateImportDatabasePath } from '../../src/import/privateImportState.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const supported = process.platform !== 'win32' && !!process.getuid;
const privateIt = it.skipIf(!supported);
const permissionIt = it.skipIf(!supported || process.getuid?.() === 0);
const roots: string[] = [], databases: Database.Database[] = [], leases: LocalHistoryChildAdmission[] = [], children: ChildProcess[] = [];
const operationId = 'a'.repeat(32), attachment = 'b'.repeat(32) + '.txt';
const helper = pathToFileURL(path.resolve(__dirname, '../../src/import/LocalHistoryStoreTemporaryRun.ts')).href;
const childSource = `import fs from 'node:fs'; import path from 'node:path';
import {openLocalHistoryStoreTemporaryRun,assertLocalHistoryStoreTemporaryAllocator} from ${JSON.stringify(helper)};
let allocator; let token;
process.on('message', message => {
  try {
    if(message.kind==='open') { token=message.token; allocator=openLocalHistoryStoreTemporaryRun(token); process.send({kind:'opened'}); }
    else if(message.kind==='write') {
      const destination=message.destination ?? path.join(token.stateDir,'imported-history','manifest.json');
      const item=allocator.allocate(destination,message.publication ?? 'replace'); item.write('SYNTHETIC PRIVATE TEMPORARY');
      if(message.failUnlink) fs.chmodSync(path.join(token.stateDir,'imported-history','.local-history-temporary',token.runId),0o500);
      let failed=false;
      if(message.publish) { try { item.publish(); } catch { failed=true; } }
      item.close(); process.send({kind:'written',artifact:item.temporaryArtifact,failed});
    } else if(message.kind==='assert') { assertLocalHistoryStoreTemporaryAllocator(allocator,message.expectedStateDir); process.send({kind:'asserted'}); }
    else if(message.kind==='finish-handles') { allocator?.close(); process.send({kind:'handles-closed'}); }
    else if(message.kind==='close') { allocator?.close(); process.exit(0); }
  } catch(error) { process.send({kind:'refused',reason:error.reason ?? 'unavailable'}); }
});
process.send({kind:'booted'}); setInterval(()=>{},1000);`;

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-temporary-run-')); roots.push(root); return root;
}
function prepare(root = temp()) {
  const directory = path.join(root, 'local-history-upload'); fs.mkdirSync(directory, { mode: 0o700 });
  const db = new Database(privateImportDatabasePath(directory, 'jobs.sqlite'));
  db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL'); databases.push(db);
  db.exec('CREATE TABLE upload_operations(id TEXT PRIMARY KEY, tag TEXT NOT NULL, phase TEXT NOT NULL, deadline INTEGER NOT NULL)');
  initializeLocalHistoryStoreTemporaryRuns(db);
  fs.mkdirSync(path.join(root, 'imported-history', 'attachments'), { recursive: true, mode: 0o700 });
  return { root, db };
}
function admitted() {
  const value = prepare(), lease = acquireLocalHistoryStoreTemporaryAdmission(value.root)!; leases.push(lease);
  value.db.prepare('INSERT INTO upload_operations VALUES(?,?,?,?)').run(operationId, 'r-' + lease.custody.generation + '-' + operationId, 'applying', Date.now() + 60_000);
  return { ...value, lease };
}
function loader(root: string): string {
  const file = path.join(root, 'resolve-types.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';import{fileURLToPath}from'node:url';
export async function resolve(specifier,context,nextResolve){try{return await nextResolve(specifier,context)}catch(error){
if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL){const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(fs.existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true}}throw error}}`);
  return file;
}
async function started(root: string, code = childSource): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-transform-types', '--experimental-loader', loader(root), '--input-type=module', '-e', code],
    { cwd: path.resolve(__dirname, '../..'), stdio: ['ignore','ignore','pipe','ipc'] });
  children.push(child);
  let stderr = ''; child.stderr?.on('data', value => { if (stderr.length < 2048) stderr += String(value).slice(0, 2048 - stderr.length); });
  const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('fixture child exited: ' + stderr); })]);
  expect(message.kind).toBe('booted');
  return child;
}
async function command(child: ChildProcess, value: object): Promise<any> {
  const result = once(child, 'message'); child.send(value); return (await result)[0];
}
async function ended(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'); child.send({kind:'close'}); await closed;
}
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
  }
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const lease of leases.splice(0)) lease.release();
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'synthetic store temporary namespace fixture' });
});

privateIt('requires actual fixed jobs SQLite and a branded real custody admission', () => {
  const {root, db, lease} = admitted();
  const memory = new Database(':memory:');
  try { expect(() => initializeLocalHistoryStoreTemporaryRuns(memory)).toThrow('temporary-invalid'); } finally { memory.close(); }
  expect(() => registerLocalHistoryStoreTemporaryRun(db, { ...lease }, { operationId })).toThrow('temporary-invalid');
  expect(() => assertLocalHistoryStoreTemporaryAllocator({allocate(){},close(){}})).toThrow('temporary-invalid');
  db.prepare('UPDATE upload_operations SET phase = ?').run('cancelled');
  expect(() => registerLocalHistoryStoreTemporaryRun(db, lease, { operationId })).toThrow();
  expect(fs.readdirSync(path.join(root, 'imported-history'))).toEqual(['attachments']);
});

privateIt('does not treat a supplied JSON token as a durable namespace record', () => {
  const {root, lease} = admitted();
  const token = { stateDir: root, runId: 'c'.repeat(32), operationId, generation: lease.custody.generation, actorNonce: 'd'.repeat(64) };
  expect(() => openLocalHistoryStoreTemporaryRun(token)).toThrow();
  expect(fs.existsSync(path.join(root, 'imported-history', '.local-history-temporary'))).toBe(false);
});

privateIt('durably binds the real child before its allocator opens and waits for actual close before cleanup', async () => {
  const {root, db, lease} = admitted();
  const run = registerLocalHistoryStoreTemporaryRun(db, lease, { operationId });
  const record = db.prepare('SELECT * FROM local_history_store_temporary_runs WHERE runId = ?').get(run.runId) as any;
  expect(record.state).toBe('registered'); expect(record.childPid).toBeNull();
  const directory = path.join(root, 'imported-history', '.local-history-temporary', run.runId);
  expect(fs.readdirSync(directory)).toEqual([]);
  expect(fs.lstatSync(directory).ino).toBe(record.directoryIno);
  const child = await started(root), token = await run.registerChild(child);
  expect(() => openLocalHistoryStoreTemporaryRun(token)).toThrow(); // parent PID cannot borrow child authority
  expect(await command(child, {kind:'open', token})).toEqual({kind:'opened'});
  expect(await command(child,{kind:'assert',expectedStateDir:root})).toEqual({kind:'asserted'});
  const wrongRoot = path.join(root,'never-created');
  expect((await command(child,{kind:'assert',expectedStateDir:wrongRoot})).kind).toBe('refused');
  expect(fs.existsSync(wrongRoot)).toBe(false);
  const written = await command(child, {kind:'write'});
  expect(written.kind).toBe('written'); expect(fs.readdirSync(directory)).toHaveLength(1);
  expect(() => run.cleanupAfterChild()).toThrow('child-alive');
  const closed = once(child, 'close'); child.kill('SIGTERM');
  expect(() => run.cleanupAfterChild()).toThrow('child-alive'); // kill sent is not exit proof
  await closed;
  run.cleanupAfterChild();
  expect(fs.existsSync(directory)).toBe(false);
  expect(db.prepare('SELECT state FROM local_history_store_temporary_runs WHERE runId = ?').get(run.runId)).toEqual({state:'disposed'});
});

privateIt('rejects foreign nonce, traversal and final destinations outside fixed manifest or generated attachment names', async () => {
  const {root, db, lease} = admitted(), run = registerLocalHistoryStoreTemporaryRun(db, lease, { operationId });
  const child = await started(root), token = await run.registerChild(child);
  const bad = await command(child, {kind:'open', token:{...token, actorNonce:'e'.repeat(64)}});
  expect(bad.kind).toBe('refused');
  expect(await command(child, {kind:'open', token})).toEqual({kind:'opened'});
  expect((await command(child, {kind:'write',destination:path.join(root,'outside.json')})).kind).toBe('refused');
  expect((await command(child, {kind:'write',destination:path.join(root,'imported-history','attachments','not-generated.txt'),publication:'first'})).kind).toBe('refused');
  expect((await command(child, {kind:'write',destination:path.join(root,'imported-history','attachments',attachment+'\n'),publication:'first'})).kind).toBe('refused');
  expect(fs.existsSync(path.join(root,'outside.json'))).toBe(false);
  await ended(child); run.cleanupAfterChild();
});

permissionIt('removes only the temporary hardlink after failed publication cleanup, preserving the published attachment', async () => {
  const {root, db, lease} = admitted(), run = registerLocalHistoryStoreTemporaryRun(db, lease, { operationId });
  const child = await started(root), token = await run.registerChild(child);
  expect(await command(child,{kind:'open',token})).toEqual({kind:'opened'});
  const final = path.join(root,'imported-history','attachments',attachment);
  const result = await command(child,{kind:'write',destination:final,publication:'first',publish:true,failUnlink:true});
  expect(result).toMatchObject({kind:'written',failed:true});
  expect(fs.lstatSync(final).nlink).toBe(2);
  await ended(child);
  expect(() => run.cleanupAfterChild()).toThrow('cleanup-pending');
  expect(fs.readFileSync(final,'utf8')).toBe('SYNTHETIC PRIVATE TEMPORARY');
  fs.chmodSync(path.join(root,'imported-history','.local-history-temporary',run.runId),0o700);
  run.cleanupAfterChild();
  expect(fs.lstatSync(final).nlink).toBe(1);
  expect(fs.readFileSync(final,'utf8')).toBe('SYNTHETIC PRIVATE TEMPORARY');
});

privateIt('preserves a replaced registered directory and unrelated lookalike namespace', async () => {
  const {root, db, lease} = admitted(), run = registerLocalHistoryStoreTemporaryRun(db,lease,{operationId});
  const child = await started(root), token = await run.registerChild(child);
  await command(child,{kind:'open',token}); await command(child,{kind:'write'}); await ended(child);
  const base = path.join(root,'imported-history','.local-history-temporary'), original = path.join(base,run.runId);
  fs.renameSync(original,path.join(base,'moved-original'));
  fs.mkdirSync(original,{mode:0o700}); fs.writeFileSync(path.join(original,'foreign'),'FOREIGN',{mode:0o600});
  const unknown = path.join(base,'f'.repeat(32)); fs.mkdirSync(unknown,{mode:0o700}); fs.writeFileSync(path.join(unknown,'unknown'),'UNKNOWN',{mode:0o600});
  expect(() => run.cleanupAfterChild()).toThrow('cleanup-pending');
  expect(fs.readFileSync(path.join(original,'foreign'),'utf8')).toBe('FOREIGN');
  lease.release();
  const next = acquireLocalHistoryStoreTemporaryAdmission(root)!; leases.push(next);
  expect(recoverLocalHistoryStoreTemporaryRuns(db,next)).toEqual({disposed:0,pending:1});
  expect(fs.readFileSync(path.join(original,'foreign'),'utf8')).toBe('FOREIGN');
  expect(fs.readFileSync(path.join(unknown,'unknown'),'utf8')).toBe('UNKNOWN');
});

privateIt('keeps cleanup pending when syncing the removed namespace fails', async () => {
  const { root, db, lease } = admitted();
  const run = registerLocalHistoryStoreTemporaryRun(db, lease, { operationId });
  const child = await started(root);
  await run.registerChild(child);
  await ended(child);
  const parent = path.join(root, 'imported-history', '.local-history-temporary');
  const namespace = path.join(parent, run.runId);
  const expected = fs.statSync(parent), sync = fs.fsyncSync;
  let attempted = false;
  const failure = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    const opened = fs.fstatSync(fd);
    if (opened.dev === expected.dev && opened.ino === expected.ino) {
      attempted = true;
      expect(fs.existsSync(namespace)).toBe(false);
      throw Object.assign(new Error('synthetic directory sync failure'), { code: 'EIO' });
    }
    return sync(fd);
  });
  try {
    expect(() => run.cleanupAfterChild()).toThrow('cleanup-pending');
    expect(attempted).toBe(true);
  } finally { failure.mockRestore(); }
  expect(fs.existsSync(namespace)).toBe(false);
  expect(db.prepare('SELECT state FROM local_history_store_temporary_runs WHERE runId = ?').get(run.runId))
    .toEqual({ state: 'cleanup-pending' });
  lease.release();
  const replacement = acquireLocalHistoryStoreTemporaryAdmission(root)!; leases.push(replacement);
  expect(recoverLocalHistoryStoreTemporaryRuns(db, replacement)).toEqual({ disposed: 0, pending: 1 });
});

privateIt('leaves old namespace and state untouched if metadata room is refused', () => {
  const { root, db, lease } = admitted();
  const run = registerLocalHistoryStoreTemporaryRun(db, lease, { operationId });
  lease.release();
  const replacement = acquireLocalHistoryStoreTemporaryAdmission(root)!; leases.push(replacement);
  const checkMetadataRoom = vi.fn(() => { throw new Error('synthetic metadata capacity refusal'); });
  expect(settleOldLocalHistoryTemporaryRuns(db, replacement, checkMetadataRoom))
    .toEqual({ disposed: 0, pending: 1, settledTags: [] });
  expect(checkMetadataRoom).toHaveBeenCalledTimes(1);
  expect(db.prepare('SELECT state FROM local_history_store_temporary_runs WHERE runId = ?').get(run.runId))
    .toEqual({ state: 'registered' });
  expect(fs.existsSync(path.join(root, 'imported-history', '.local-history-temporary', run.runId))).toBe(true);
});

privateIt('cannot recover current-generation namespaces and retains typed rows instead of retiring them', async () => {
  const {root,db,lease} = admitted(), run = registerLocalHistoryStoreTemporaryRun(db,lease,{operationId});
  expect(recoverLocalHistoryStoreTemporaryRuns(db,lease)).toEqual({disposed:0,pending:0});
  expect(fs.existsSync(path.join(root,'imported-history','.local-history-temporary',run.runId))).toBe(true);
  lease.release();
  const replacement = acquireLocalHistoryStoreTemporaryAdmission(root)!; leases.push(replacement);
  expect(recoverLocalHistoryStoreTemporaryRuns(db,replacement)).toEqual({disposed:1,pending:0});
  expect(db.prepare('SELECT COUNT(*) AS count FROM local_history_store_temporary_runs').get()).toEqual({count:1});
});

privateIt('refuses stale operation phases before payload allocation and publication', async () => {
  const {root,db,lease} = admitted(), run = registerLocalHistoryStoreTemporaryRun(db,lease,{operationId});
  const child = await started(root), token = await run.registerChild(child);
  await command(child,{kind:'open',token});
  db.prepare('UPDATE upload_operations SET phase = ?').run('cancelled');
  expect((await command(child,{kind:'write'})).kind).toBe('refused');
  expect(fs.readdirSync(path.join(root,'imported-history','.local-history-temporary',run.runId))).toEqual([]);
  await ended(child); run.cleanupAfterChild();
});

privateIt('retains custody after allocator.close and parent death until the real orphan child exits', async () => {
  const {root,db} = prepare();
  const parentCode = `import Database from 'better-sqlite3';import path from 'node:path';import{spawn}from'node:child_process';import{once}from'node:events';
import{acquireLocalHistoryStoreTemporaryAdmission,registerLocalHistoryStoreTemporaryRun}from${JSON.stringify(helper)};
const root=${JSON.stringify(root)},operation=${JSON.stringify(operationId)};
const lease=acquireLocalHistoryStoreTemporaryAdmission(root);
const db=new Database(path.join(root,'local-history-upload','jobs.sqlite'));
db.prepare('INSERT INTO upload_operations VALUES(?,?,?,?)').run(operation,'r-'+lease.custody.generation+'-'+operation,'applying',Date.now()+60000);
process.on('message',async message=>{if(message.kind!=='begin')return;
try{
 const run=registerLocalHistoryStoreTemporaryRun(db,lease,{operationId:operation});
 const child=spawn(process.execPath,['--no-warnings','--experimental-transform-types','--experimental-loader',${JSON.stringify(loader(root))},'--input-type=module','-e',${JSON.stringify(childSource)}],{stdio:['ignore','ignore','ignore','ipc']});
 await once(child,'message');const token=await run.registerChild(child);
 async function send(value){const response=once(child,'message');child.send(value);return(await response)[0]}
 if((await send({kind:'open',token})).kind!=='opened')throw Error('open');
 if((await send({kind:'write'})).kind!=='written')throw Error('write');
 if((await send({kind:'finish-handles'})).kind!=='handles-closed')throw Error('close');
 process.send({kind:'orphan-held',pid:child.pid,runId:run.runId});
}catch{process.send({kind:'fixture-failed'})}});
process.send({kind:'booted'});setInterval(()=>{},1000);`;
  const parent = await started(root,parentCode);
  let orphan = 0;
  try {
    const message = await command(parent,{kind:'begin'});
    expect(message.kind).toBe('orphan-held'); orphan = message.pid;
    const directory = path.join(root,'imported-history','.local-history-temporary',message.runId);
    expect(fs.readdirSync(directory)).toHaveLength(1);
    expect(acquireLocalHistoryStoreTemporaryAdmission(root)).toBeNull();
    const parentClosed = once(parent,'close'); parent.kill('SIGKILL'); await parentClosed;
    // No parent/WeakMap survives. The closed allocator's process-lifetime
    // SQLite holder still rejects takeover while its real child lingers.
    expect(acquireLocalHistoryStoreTemporaryAdmission(root)).toBeNull();
    expect(fs.readdirSync(directory)).toHaveLength(1);
    process.kill(orphan,'SIGKILL');
    let replacement: LocalHistoryChildAdmission | null = null;
    const end = Date.now()+5000;
    while (!replacement && Date.now()<end) {
      replacement=acquireLocalHistoryStoreTemporaryAdmission(root);
      if(!replacement) await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(replacement).not.toBeNull(); leases.push(replacement!);
    expect(recoverLocalHistoryStoreTemporaryRuns(db,replacement!)).toEqual({disposed:1,pending:0});
    expect(fs.existsSync(directory)).toBe(false);
  } finally { if(orphan){try{process.kill(orphan,'SIGKILL')}catch{/* already exited */}} }
});

privateIt('rejects a closed real allocator and still retains its child custody', async () => {
  const {root,db,lease}=admitted(),run=registerLocalHistoryStoreTemporaryRun(db,lease,{operationId});
  const child=await started(root),token=await run.registerChild(child);
  await command(child,{kind:'open',token});
  expect(await command(child,{kind:'finish-handles'})).toEqual({kind:'handles-closed'});
  expect((await command(child,{kind:'assert',expectedStateDir:root})).kind).toBe('refused');
  lease.release();
  expect(acquireLocalHistoryStoreTemporaryAdmission(root)).toBeNull();
  await ended(child);
  const replacement=acquireLocalHistoryStoreTemporaryAdmission(root)!;leases.push(replacement);
  expect(recoverLocalHistoryStoreTemporaryRuns(db,replacement)).toEqual({disposed:1,pending:0});
});
