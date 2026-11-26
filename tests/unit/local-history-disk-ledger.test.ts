import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { localHistoryUploadDirectory } from '../../src/import/LocalHistoryExchange.js';
import { privateImportDatabasePath } from '../../src/import/privateImportState.js';
import { acquireLocalHistoryStoreTemporaryAdmission, localHistoryCopyRunTag } from '../../src/import/LocalHistoryStoreTemporaryRun.js';
import { LocalHistoryDiskLedger } from '../../src/import/LocalHistoryDiskLedger.js';
import { mediaDiskFloorBytes } from '../../src/core/AppMediaStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
const ledgers: LocalHistoryDiskLedger[] = [];
const total = 100 * 1024 ** 3;
it('refuses an earlier unversioned schema intact before accepting allocations', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-old-ledger-')); dirs.push(stateDir);
  const directory = localHistoryUploadDirectory(stateDir);
  const filename = privateImportDatabasePath(directory, 'disk-ledger.sqlite');
  const db = new Database(filename);
  try {
    db.exec("CREATE TABLE allocations (id TEXT PRIMARY KEY, operation TEXT, planned INTEGER, written INTEGER, state TEXT CHECK(state IN ('active','cleanup-pending','disposed')), dev INTEGER, ino INTEGER, disposedAt INTEGER)");
    db.prepare('INSERT INTO allocations VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)').run('a'.repeat(32), 'synthetic-legacy', 100, 0, 'active');
    const before = db.prepare('SELECT * FROM allocations').all();
    expect(() => new LocalHistoryDiskLedger(stateDir, { disk: () => ({ total, free: total }) })).toThrow('disk-schema');
    expect(db.prepare('SELECT * FROM allocations').all()).toEqual(before);
    expect(db.pragma('user_version', { simple: true })).toBe(0);
  } finally { db.close(); }
});
it('rolls back a new schema if its version marker cannot commit and permits retry', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-schema-interruption-')); dirs.push(stateDir);
  const original = Database.prototype.pragma;
  const marker = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, sql: string, options?: Database.PragmaOptions) {
    if (sql === 'user_version = 1') throw new Error('synthetic initialization interruption');
    return original.call(this, sql, options);
  });
  try { expect(() => new LocalHistoryDiskLedger(stateDir, { disk: () => ({ total, free: total }) })).toThrow('synthetic initialization interruption'); }
  finally { marker.mockRestore(); }
  const inspect = new Database(path.join(stateDir, 'local-history-upload', 'disk-ledger.sqlite'));
  try { expect(inspect.prepare("SELECT 1 FROM sqlite_master WHERE name = 'allocations'").get()).toBeUndefined(); }
  finally { inspect.close(); }
  const retry = new LocalHistoryDiskLedger(stateDir, { disk: () => ({ total, free: total }) }); ledgers.push(retry);
  expect(retry.create('synthetic-retry', 1)).toEqual(expect.any(String));
});
function setup(capacity = 100) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-disk-')); dirs.push(stateDir);
  const disk = () => {
    const root = path.join(stateDir, 'local-history-upload', 'blocks');
    const allocated = fs.existsSync(root) ? fs.readdirSync(root).reduce((n, name) => n + fs.statSync(path.join(root, name)).size, 0) : 0;
    return { total, free: mediaDiskFloorBytes(total) + 64 * 1024 + capacity - allocated };
  };
  const ledger = new LocalHistoryDiskLedger(stateDir, { disk }); ledgers.push(ledger);
  return { stateDir, ledger, disk };
}
afterEach(() => { vi.restoreAllMocks(); for (const ledger of ledgers.splice(0)) ledger.close(); for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'disk ledger fixture cleanup' }); });

it('reserves before growth and charges physical writes exactly once across another handle', () => {
  const f = setup(); const id = f.ledger.create('synthetic-operation', 100);
  const other = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk }); ledgers.push(other);
  expect(() => other.create('other', 1)).toThrow('disk-capacity');
  f.ledger.write(id, Buffer.alloc(40, 65));
  expect(other.inspect(id)).toMatchObject({ planned: 100, written: 40, state: 'active' });
  expect(() => other.create('other', 1)).toThrow('disk-capacity');
  expect(other.read(id, 0, 100)).toEqual(Buffer.alloc(40, 65));
  f.ledger.dispose(id);
  expect(() => other.read(id, 0, 1)).toThrow('disk-allocation-unavailable');
  expect(other.create('other', 100)).toEqual(expect.any(String));
});
it('allows low-disk recovery to dispose existing allocations while refusing new admission', () => {
  const f = setup(), id = f.ledger.create('synthetic-operation', 100);
  f.ledger.write(id, Buffer.alloc(100, 65));
  const recovering = new LocalHistoryDiskLedger(f.stateDir, { disk: () => ({ total, free: 0 }) }); ledgers.push(recovering);
  expect(() => recovering.create('new-operation', 1)).toThrow('disk-capacity');
  recovering.dispose(id);
  expect(f.ledger.inspect(id).state).toBe('disposed');
  expect(fs.existsSync(path.join(f.stateDir, 'local-history-upload', 'blocks', id))).toBe(false);
});

it('refuses writes beyond the durable plan before changing any bytes', () => {
  const f = setup(); const id = f.ledger.create('synthetic-operation', 3);
  expect(() => f.ledger.write(id, Buffer.from('four'))).toThrow('disk-plan-exceeded');
  expect(f.ledger.inspect(id).written).toBe(0);
  expect(f.ledger.read(id, 0, 1)).toHaveLength(0);
  f.ledger.grow(id, 1); f.ledger.write(id, Buffer.from('four'));
  expect(f.ledger.read(id, 0, 4).toString()).toBe('four');
});

it('has no aggregate fifty-megabyte project ceiling when measured capacity is sufficient', () => {
  const f = setup(256 * 1024 ** 2);
  const id = f.ledger.create('synthetic-operation', 63 * 1024 ** 2);
  expect(f.ledger.inspect(id).planned).toBe(63 * 1024 ** 2);
});

it('retains charged residue when owned deletion fails and refuses further writes', () => {
  const f = setup(); const id = f.ledger.create('synthetic-operation', 100);
  f.ledger.write(id, Buffer.alloc(30));
  const unlink = vi.spyOn(SafeFsExecutor, 'safeUnlinkSync').mockImplementation(() => { throw new Error('synthetic deletion failure'); });
  expect(() => f.ledger.dispose(id)).toThrow('disk-cleanup-pending');
  expect(f.ledger.inspect(id)).toMatchObject({ planned: 100, written: 30, state: 'cleanup-pending' });
  expect(() => f.ledger.write(id, Buffer.alloc(1))).toThrow('disk-allocation-unavailable');
  expect(() => f.ledger.create('other', 1)).toThrow('disk-capacity');
  unlink.mockRestore(); f.ledger.dispose(id);
  expect(f.ledger.create('other', 100)).toEqual(expect.any(String));
});

it('accounts for a partial native write even when the next write fails', () => {
  const f = setup(); const id = f.ledger.create('synthetic-operation', 100);
  const original = fs.writeSync; let calls = 0;
  const write = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    if (++calls === 1) return original(fd, buffer, offset, 2, position);
    throw new Error('synthetic ENOSPC after partial write');
  }) as typeof fs.writeSync);
  expect(() => f.ledger.write(id, Buffer.from('abcdef'))).toThrow('disk-write-interrupted');
  write.mockRestore();
  expect(f.ledger.inspect(id)).toMatchObject({ written: 2, planned: 100 });
  expect(f.ledger.read(id, 0, 100).toString()).toBe('ab');
  expect(() => f.ledger.create('other', 1)).toThrow('disk-capacity');
});

it('retains bounded recovery inventory and refuses unknown disk measurements', () => {
  const f = setup(); const id = f.ledger.create('synthetic-operation', 0);
  expect(f.ledger.list('synthetic-operation')).toEqual([expect.objectContaining({ id })]);
  expect(f.ledger.list('another-operation')).toEqual([]);
  expect(() => new LocalHistoryDiskLedger(f.stateDir, { disk: () => ({total: NaN, free: 1}) })).toThrow('disk-unavailable');
  const limited = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk, recordCapacity: 1 }); ledgers.push(limited);
  limited.dispose(id);
  expect(() => limited.create('another-operation', 1)).toThrow('disk-record-capacity');
});

it('reconciles a real crash after file growth before the SQLite debit without losing the reservation', async () => {
  const f = setup(); const id = f.ledger.create('synthetic-operation', 100);
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../dist/import/LocalHistoryDiskLedger.js')).href;
  const code = `import fs from 'node:fs'; import {LocalHistoryDiskLedger} from ${JSON.stringify(moduleUrl)};
    const ledger = new LocalHistoryDiskLedger(process.argv[1],{disk:()=>({total:${total},free:${mediaDiskFloorBytes(total)+64*1024+100}})});
    const original=fs.writeSync; fs.writeSync=function(...args){const n=original(...args);process.kill(process.pid,'SIGKILL');return n;};
    ledger.write(process.argv[2],Buffer.alloc(40,65));`;
  const child = spawn(process.execPath,['--input-type=module','-e',code,f.stateDir,id],{stdio:'ignore'});
  const [exitCode, signal] = await once(child,'exit');
  expect(exitCode).toBeNull(); expect(signal).toBe('SIGKILL');
  expect(f.ledger.inspect(id).written).toBe(0);
  expect(() => f.ledger.read(id,0,40)).toThrow('disk-reconcile-required');
  expect(() => f.ledger.create('other',1)).toThrow('disk-capacity');
  f.ledger.reconcile(id);
  expect(f.ledger.inspect(id).written).toBe(40);
  expect(f.ledger.read(id,0,40)).toEqual(Buffer.alloc(40,65));
  expect(() => f.ledger.create('other',1)).toThrow('disk-capacity');
});

it('atomically admits only one process competing for the final disk budget', async () => {
  const f = setup();
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../dist/import/LocalHistoryDiskLedger.js')).href;
  const code = `import {LocalHistoryDiskLedger} from ${JSON.stringify(moduleUrl)};
    const ledger = new LocalHistoryDiskLedger(process.argv[1],{disk:()=>({total:${total},free:${mediaDiskFloorBytes(total)+64*1024+100}})});
    process.once('message',()=>{try{const id=ledger.create('competing-operation',100);process.send({admitted:true,id});}catch(error){process.send({admitted:false,code:error.message});}finally{ledger.close();process.disconnect();}});
    process.send('ready');`;
  const children: ReturnType<typeof spawn>[] = [];
  const exits: Promise<unknown>[] = [];
  try {
    for(let index=0;index<2;index++) {
      const child=spawn(process.execPath,['--input-type=module','-e',code,f.stateDir],{stdio:['ignore','ignore','ignore','ipc']});
      children.push(child);const exit=once(child,'exit');exits.push(exit);
      const [ready]=await Promise.race([once(child,'message'),exit.then(()=>{throw new Error('budget competitor exited early');})]);
      expect(ready).toBe('ready');
    }
    const results=children.map(child=>once(child,'message'));
    for(const child of children)child.send('go');
    const messages=await Promise.all(results);
    expect(messages.filter(([message])=>message.admitted)).toHaveLength(1);
    expect(messages.filter(([message])=>!message.admitted)).toHaveLength(1);
    const loser = messages.find(([message])=>!message.admitted)![0];
    expect(['local-history-disk-busy','local-history-disk-capacity']).toContain(loser.code);
    const winner = messages.find(([message])=>message.admitted)![0];
    expect(f.ledger.inspect(winner.id)).toMatchObject({ operation: 'competing-operation', planned: 100, written: 0, state: 'active' });
    await Promise.all(exits);
  } finally {
    children.forEach(child=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});await Promise.all(exits);
  }
});

it('serializes file creation with a competing disposal after durable reservation', () => {
  const f = setup(); const other = new LocalHistoryDiskLedger(f.stateDir, { disk: f.disk }); ledgers.push(other);
  const original = fs.openSync; let interleaved = false;
  const open = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: number, mode: number) => {
    if (!interleaved && typeof file === 'string' && path.dirname(file).endsWith('/blocks')) {
      interleaved = true;
      expect(() => other.dispose(path.basename(file))).toThrow('disk-busy');
    }
    return original(file, flags, mode);
  }) as typeof fs.openSync);
  const id = f.ledger.create('synthetic-operation', 100); open.mockRestore();
  expect(interleaved).toBe(true); expect(f.ledger.inspect(id).state).toBe('active');
  f.ledger.dispose(id); expect(fs.readdirSync(path.join(f.stateDir, 'local-history-upload', 'blocks'))).toEqual([]);
});

it('refuses a damaged row that would otherwise subtract another reservation', async () => {
  const f = setup(); const first = f.ledger.create('synthetic-operation', 50); const second = f.ledger.create('second', 50);
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.join(f.stateDir,'local-history-upload','disk-ledger.sqlite'));
  db.pragma('ignore_check_constraints = ON');
  db.prepare('UPDATE allocations SET written = 100 WHERE id = ?').run(first); db.close();
  expect(() => f.ledger.create('other', 1)).toThrow('disk-unavailable');
  expect(() => f.ledger.grow(second, 1)).toThrow('disk-unavailable');
  expect(() => f.ledger.write(second, Buffer.alloc(1))).toThrow('disk-unavailable');
});

it('recovers a durable reservation whose file creation failed without losing its cleanup handle', () => {
  const f = setup(); const original = fs.openSync;
  const open = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: number, mode: number) => {
    if (typeof file === 'string' && path.dirname(file).endsWith('/blocks')) throw new Error('synthetic ENOSPC');
    return original(file, flags, mode);
  }) as typeof fs.openSync);
  expect(() => f.ledger.create('synthetic-operation', 100)).toThrow('disk-create-interrupted');
  open.mockRestore();
  const rows = f.ledger.list('synthetic-operation'); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ planned: 100, written: 0, state: 'active' });
  expect(() => f.ledger.create('other', 1)).toThrow('disk-capacity');
  f.ledger.dispose(rows[0].id);
  expect(f.ledger.create('other', 100)).toEqual(expect.any(String));
});

it('rechecks live storage before the next block and does not silently write a partial selection', () => {
  const f = setup(); const id = f.ledger.create('synthetic-operation', 100); f.ledger.write(id, Buffer.alloc(40, 65));
  let available = 50;
  const pressured = new LocalHistoryDiskLedger(f.stateDir, { disk: () => ({ total, free: mediaDiskFloorBytes(total) + 64*1024 + available }) }); ledgers.push(pressured);
  expect(() => pressured.write(id, Buffer.alloc(1))).toThrow('disk-capacity');
  expect(f.ledger.inspect(id).written).toBe(40); expect(f.ledger.read(id, 0, 100)).toEqual(Buffer.alloc(40, 65));
  available = 60; pressured.write(id, Buffer.alloc(1, 66));
  expect(f.ledger.inspect(id).written).toBe(41); expect(f.ledger.read(id, 40, 1)).toEqual(Buffer.from('B'));
});

it('refuses oversized blocks and reads before allocating or writing their payload', () => {
  const f = setup(2*1024*1024); const id = f.ledger.create('synthetic-operation', 2*1024*1024);
  expect(() => f.ledger.write(id, Buffer.alloc(1024*1024+1))).toThrow('disk-block-capacity');
  expect(() => f.ledger.read(id, 0, 1024*1024+1)).toThrow('disk-block-capacity');
  expect(f.ledger.inspect(id).written).toBe(0);
});
it('fills positive short reads and makes sealed allocations immutable through the ledger', () => {
  const f = setup(), id = f.ledger.create('synthetic-operation', 8); f.ledger.write(id, Buffer.from('abcdefgh'));
  const original = fs.readSync;
  const read = vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    original(fd, buffer, offset, Math.min(length, 2), position)) as typeof fs.readSync);
  expect(f.ledger.read(id, 0, 8).toString()).toBe('abcdefgh'); read.mockRestore();
  f.ledger.seal(id); expect(f.ledger.inspect(id).state).toBe('sealed');
  expect(f.ledger.read(id, 0, 8).toString()).toBe('abcdefgh');
  expect(() => f.ledger.write(id, Buffer.alloc(0))).toThrow('disk-allocation-unavailable');
  expect(() => f.ledger.grow(id, 1)).toThrow('disk-allocation-unavailable');
  expect(() => f.ledger.reconcile(id)).toThrow('disk-allocation-unavailable');
  f.ledger.dispose(id);
});

it.each(['upload', 'blocks'] as const)('refuses copy admission when the original ledger %s directory is replaced', target => {
  const { stateDir, ledger } = setup();
  const destination = path.join(stateDir, 'destination');
  fs.mkdirSync(destination);
  const pin = ledger.pinCopyVolume([destination]);
  try {
    expect(pin.measure().blockBytes).toBeGreaterThan(0);
    const upload = localHistoryUploadDirectory(stateDir);
    const replaced = target === 'upload' ? upload : path.join(upload, 'blocks');
    fs.renameSync(replaced, path.join(stateDir, 'original'));
    fs.mkdirSync(replaced, { mode: 0o700 });
    if (target === 'upload') fs.mkdirSync(path.join(replaced, 'blocks'), { mode: 0o700 });
    expect(() => pin.revalidate()).toThrow('local-history-copy-volume');
    expect(() => ledger.pinCopyVolume([destination])).toThrow('local-history-copy-volume');
  } finally {
    pin.close();
  }
});

it('creates one dedicated reservation for a live operation and pins its identity and ceiling', () => {
  const { stateDir, ledger } = setup();
  const operationId = 'a'.repeat(32);
  const lease = acquireLocalHistoryStoreTemporaryAdmission(stateDir)!;
  const destination = path.join(stateDir, 'copy-destination');
  fs.mkdirSync(destination);
  const pin = ledger.pinCopyVolume([destination]);
  try {
    const tag = localHistoryCopyRunTag(lease, stateDir, operationId);
    const other = ledger.create(tag, 1);
    expect(() => ledger.createCopyRunReservation(lease, operationId, { ...pin }, 10, 100)).toThrow('copy-reservation');
    expect(() => ledger.createCopyRunReservation({ ...lease }, operationId, pin, 10, 100)).toThrow();
    expect(() => ledger.createCopyRunReservation(lease, operationId, pin, 100, 100)).toThrow('disk-capacity');
    const reservation = ledger.createCopyRunReservation(lease, operationId, pin, 10, 100);
    expect(() => ledger.createCopyRunReservation(lease, operationId, pin, 1, 100)).toThrow('copy-reservation');
    const secondLedger = new LocalHistoryDiskLedger(stateDir);
    try {
      const secondPin = secondLedger.pinCopyVolume([destination]);
      try {
        expect(() => secondLedger.createCopyRunReservation(lease, operationId, secondPin, 1, 100)).toThrow('copy-reservation');
      } finally { secondPin.close(); }
    } finally { secondLedger.close(); }
    reservation.grow(25);
    reservation.grow(5);
    expect(ledger.inspect(other).planned).toBe(1);
    expect(ledger.inspect(reservation.allocationId)).toMatchObject({ planned: 40, written: 0 });
    reservation.assertCovers(40);
    expect(() => reservation.assertCovers(41)).toThrow('copy-reservation');
    expect(() => reservation.assertCovers(0)).toThrow('copy-reservation');
    expect(() => reservation.grow(61)).toThrow('copy-reservation');
    expect(() => reservation.grow(60)).toThrow('disk-capacity');

    const file = path.join(localHistoryUploadDirectory(stateDir), 'blocks', reservation.allocationId);
    const fd = fs.openSync(file, 'r+');
    try {
      fs.writeSync(fd, Buffer.from('x'), 0, 1, 0);
      expect(() => reservation.grow(1)).toThrow('copy-reservation');
      expect(() => reservation.assertCovers(40)).toThrow('copy-reservation');
      fs.ftruncateSync(fd, 0);
    } finally { fs.closeSync(fd); }
    fs.renameSync(destination, path.join(stateDir, 'moved-destination'));
    fs.mkdirSync(destination);
    expect(() => reservation.grow(1)).toThrow();
    expect(() => reservation.assertCovers(40)).toThrow();
    expect(ledger.inspect(reservation.allocationId)).toMatchObject({ planned: 40, written: 0 });
  } finally {
    pin.close();
    lease.release();
  }
});

it('retains an interrupted bootstrap charge and refuses a second creation in the same operation', () => {
  const { stateDir, ledger } = setup();
  const operationId = 'b'.repeat(32);
  const lease = acquireLocalHistoryStoreTemporaryAdmission(stateDir)!;
  const destination = path.join(stateDir, 'copy-destination');
  fs.mkdirSync(destination);
  const pin = ledger.pinCopyVolume([destination]);
  const blocks = path.join(localHistoryUploadDirectory(stateDir), 'blocks');
  const original = fs.openSync;
  const opens = vi.spyOn(fs, 'openSync').mockImplementation(((file: string, flags: number, mode?: number) => {
    if (typeof file === 'string' && path.dirname(file) === blocks && (flags & fs.constants.O_EXCL)) {
      throw new Error('synthetic placeholder creation failure');
    }
    return original(file, flags, mode);
  }) as typeof fs.openSync);
  try {
    expect(() => ledger.createCopyRunReservation(lease, operationId, pin, 10, 100)).toThrow('disk-create-interrupted');
    opens.mockRestore();
    expect(() => ledger.createCopyRunReservation(lease, operationId, pin, 10, 100)).toThrow('copy-reservation');
    const tag = localHistoryCopyRunTag(lease, stateDir, operationId);
    expect(ledger.list(tag)).toMatchObject([{ planned: 10, written: 0, state: 'active' }]);
  } finally {
    opens.mockRestore();
    pin.close();
    lease.release();
  }
});


it('rechecks the floor against the full existing charge without growing it', () => {
  const { stateDir } = setup();
  let available = 100;
  const ledger = new LocalHistoryDiskLedger(stateDir, {
    disk: () => ({ total, free: mediaDiskFloorBytes(total) + 64 * 1024 + available }),
  });
  ledgers.push(ledger);
  const lease = acquireLocalHistoryStoreTemporaryAdmission(stateDir)!;
  const pin = ledger.pinCopyVolume([stateDir]);
  try {
    ledger.create('other-operation', 60);
    const reservation = ledger.createCopyRunReservation(lease, 'b'.repeat(32), pin, 40, 40);
    reservation.assertCovers(40);
    available--;
    expect(() => reservation.assertCovers(40)).toThrow('disk-capacity');
    expect(ledger.inspect(reservation.allocationId)).toMatchObject({ planned: 40, written: 0 });
    available++;
    reservation.assertCovers(40);
  } finally {
    pin.close();
    lease.release();
  }
});
