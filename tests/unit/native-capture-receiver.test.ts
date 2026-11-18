import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeCaptureCaller } from '../../src/server/nativeCaptureAdmission.js';
import { AcquisitionArchives } from '../../src/import/archiveStaging.js';
import { HistoryAcquisitionWorker, type WorkerOptions } from '../../src/import/HistoryAcquisitionWorker.js';
import { ImportedHistoryStore } from '../../src/import/ImportedHistoryStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { makeZip } from '../helpers/exportZip.js';

const owner = {owner:'owner:default',machine:'signed-mac',conversation:'private-owner-chat'};
const account = {provider:'chatgpt' as const,profileId:'dedicated',expectedEmail:'owner@example.test',workspace:'personal' as const};
const zip = makeZip([{name:'user.json',data:JSON.stringify({email:account.expectedEmail})},
  {name:'conversations.json',data:'[]'}]);
const sha = (bytes:Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

describe.skipIf(process.platform !== 'darwin')('same-Mac path-free receipt',() => {
  let dir:string, appRoot:string, options:WorkerOptions, granted:boolean, now:number, worker:HistoryAcquisitionWorker, id:string;
  const caller = {owner:owner.owner,machine:owner.machine,deviceId:'local-install',keyHash:'local-test-key',isCurrent:() => true} as NativeCaptureCaller;
  const changed = (fields:Record<string,unknown>) => ({...caller,...fields}) as NativeCaptureCaller;
  const notice = vi.fn(async () => { throw new Error('unexpected-second-redemption'); });
  beforeEach(async () => {
    now = Date.now(); granted = true; notice.mockClear();
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'native-capture-test-')));
    appRoot = path.join(dir,'Application Support'); fs.mkdirSync(appRoot,{mode:0o700});
    options = {stateDir:dir,now:() => now,authorized:chat => chat.owner===owner.owner && chat.machine===owner.machine && chat.conversation===owner.conversation,
      nativeCapture:{applicationSupportRoot:appRoot,verifySignedStart:(_job,msg) => msg==='signed-origin-fixture',hasDeliveryGrant:() => granted},
      connection:{available:() => ['chatgpt'],accounts:() => [account],
        delivery:() => ({readNotice:notice,verifyIdentity:async () => null})},
      request:async (_job,controls) => { expect(await controls.reserveSubmission()).toBe(true); return {status:'acknowledged'}; }};
    worker = new HistoryAcquisitionWorker(options);
    id = (await worker.start(owner,'chatgpt',account.expectedEmail,'signed-origin-fixture')).id;
  });
  afterEach(async () => { await worker.close(); SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'cleanup synthetic native capture fixture'}); });
  const issue = () => worker.issueNativeCapture(owner,id,caller);
  const receipt = (captureId:string) => ({captureId,size:zip.length,sha256:sha(zip)});
  const write = (captureId:string,bytes=zip) => {
    const capture = path.join(appRoot,'Instar','acquisition',captureId);
    fs.mkdirSync(capture,{recursive:true,mode:0o700});
    const file = path.join(capture,'export.zip'); fs.writeFileSync(file,bytes,{mode:0o600});return file;
  };
  const restart = async (native=true) => { await worker.close(); worker = new HistoryAcquisitionWorker({...options,nativeCapture:native?options.nativeCapture:undefined}); };
  it('binds a single issued UUID to the installation; copies only verified bytes; replays an exact acknowledgment after restart',async () => {
    const lease=issue(); expect(issue()).toEqual(lease);
    const {captureId}=lease; const r=receipt(captureId);
    for (const foreign of [{deviceId:'phone'},{keyHash:'rotated'},{owner:'other'},{machine:'other'},{isCurrent:()=>false}]) {
      await expect(worker.receiveNativeCapture(changed(foreign),r)).rejects.toThrow('capture-unavailable');
    }
    write(captureId);
    await expect(worker.receiveNativeCapture(caller,{...r,path:'/untrusted'} as never)).rejects.toThrow('invalid-capture-receipt');
    expect(await worker.receiveNativeCapture(caller,r)).toEqual({accepted:true});
    expect(new ImportedHistoryStore(dir).listConversations()).toHaveLength(0);
    await restart();
    expect(await worker.receiveNativeCapture(caller,r)).toEqual({accepted:true});
    await expect(worker.receiveNativeCapture(caller,{...r,sha256:'0'.repeat(64)})).rejects.toThrow('capture-receipt-conflict');
    expect((await worker.step(owner,id)).phase).toBe('review');
    expect((await worker.preview(owner,id)).preview.chats).toBe(0);
    expect(notice).not.toHaveBeenCalled();
  });
  it('rejects digest or size mismatches before publication and pins the original receipt across restart',async () => {
    const {captureId}=issue(); const file=write(captureId,Buffer.alloc(zip.length,42)); const r=receipt(captureId);
    const archives=new AcquisitionArchives(dir);
    await expect(worker.receiveNativeCapture(caller,r)).rejects.toThrow();
    expect(archives.hasArchive(id)).toBe(false);
    await restart();
    await expect(worker.receiveNativeCapture(caller,{...r,sha256:sha(fs.readFileSync(file))})).rejects.toThrow('capture-receipt-conflict');
    fs.writeFileSync(file,zip.subarray(0,8));
    await expect(worker.receiveNativeCapture(caller,r)).rejects.toThrow();
    expect(archives.hasArchive(id)).toBe(false);
    fs.writeFileSync(file,zip); expect(await worker.receiveNativeCapture(caller,r)).toEqual({accepted:true});
  });
  it('recovers after verified archive publication but before the receipt ACK commit, without reopening a missing native file',async () => {
    const {captureId}=issue(); const file=write(captureId,Buffer.alloc(zip.length)); const r=receipt(captureId);
    await expect(worker.receiveNativeCapture(caller,r)).rejects.toThrow();
    // Simulate the durable boundary crossed immediately before a process death.
    await new AcquisitionArchives(dir).stageReceipt(id,Readable.from(zip),r,() => true);
    SafeFsExecutor.safeUnlinkSync(file,{operation:'native-capture-receiver.test:remove-native-source'}); await restart();
    expect(await worker.receiveNativeCapture(caller,r)).toEqual({accepted:true});
    expect((await worker.step(owner,id)).phase).toBe('review');
  });
  it('keeps a verified published archive when the lease expired before restart, and discards a mismatched one',async () => {
    const {captureId}=issue(); const file=write(captureId,Buffer.alloc(zip.length)); const r=receipt(captureId);
    await expect(worker.receiveNativeCapture(caller,r)).rejects.toThrow();
    await new AcquisitionArchives(dir).stageReceipt(id,Readable.from(zip),r,() => true);
    SafeFsExecutor.safeUnlinkSync(file,{operation:'native-capture-receiver.test:remove-native-source'});
    now += 16*60_000; await restart();
    expect(new AcquisitionArchives(dir).hasArchive(id)).toBe(true); // the boot sweep leaves it for reconciliation
    // Before reconciliation the expired lease refuses a late receipt; afterwards it replays as accepted.
    await expect(worker.receiveNativeCapture(caller,r)).rejects.toThrow();
    worker.startPolling(() => undefined,true);
    await vi.waitFor(async () => expect(await worker.receiveNativeCapture(caller,r)).toEqual({accepted:true}));
    expect(new AcquisitionArchives(dir).hasArchive(id)).toBe(true);
    expect((await worker.step(owner,id)).phase).toBe('review');
  });
  it('discards a matching published archive when its job has passed its deadline',async () => {
    const {captureId}=issue(); write(captureId,Buffer.alloc(zip.length)); const r=receipt(captureId);
    await expect(worker.receiveNativeCapture(caller,r)).rejects.toThrow();
    await new AcquisitionArchives(dir).stageReceipt(id,Readable.from(zip),r,() => true);
    now += 9*24*60*60_000; await restart();
    worker.startPolling(() => undefined,true);
    await vi.waitFor(() => expect(new AcquisitionArchives(dir).hasArchive(id)).toBe(false));
    await expect(worker.receiveNativeCapture(caller,r)).rejects.toThrow();
  });
  it('discards an expired published archive whose bytes no longer match the lease',async () => {
    const {captureId}=issue(); write(captureId,Buffer.alloc(zip.length)); const r=receipt(captureId);
    await expect(worker.receiveNativeCapture(caller,r)).rejects.toThrow();
    const other=makeZip([{name:'user.json',data:JSON.stringify({email:account.expectedEmail})},{name:'conversations.json',data:'[{}]'}]);
    await new AcquisitionArchives(dir).stageReceipt(id,Readable.from(other),{captureId,size:other.length,sha256:sha(other)},() => true);
    now += 16*60_000; await restart();
    worker.startPolling(() => undefined,true);
    await vi.waitFor(() => expect(new AcquisitionArchives(dir).hasArchive(id)).toBe(false));
    expect(worker.status(owner,id)?.phase).not.toBe('review');
  });
  it('stops an in-flight receipt and leaves nothing visible after owner cancellation',async () => {
    const {captureId}=issue(); write(captureId);
    const pending=worker.receiveNativeCapture(caller,receipt(captureId));
    expect(worker.cancel(owner,id)).toBe(true);
    await expect(pending).rejects.toThrow();
    expect(new AcquisitionArchives(dir).hasArchive(id)).toBe(false);
  });
  it('requires the original signed account selection before issuing or consuming a lease',async () => {
    options.nativeCapture!.verifySignedStart=() => false;
    expect(issue).toThrow('capture-unavailable');
    options.nativeCapture!.verifySignedStart=() => true;
    const {captureId}=issue(); write(captureId);
    options.nativeCapture!.verifySignedStart=() => false;
    await expect(worker.receiveNativeCapture(caller,receipt(captureId))).rejects.toThrow('capture-unavailable');
    expect(new AcquisitionArchives(dir).hasArchive(id)).toBe(false);
  });
  it.each(['symlink','hardlink','world-readable','parent-link'])('refuses an unsafe %s source and never removes unrelated files',async kind => {
    const {captureId}=issue(); const file=write(captureId);
    const outside=path.join(dir,'unrelated'); fs.writeFileSync(outside,zip,{mode:0o600});
    if (kind==='parent-link') {
      const parent=path.dirname(file); fs.renameSync(parent,parent+'-real'); fs.symlinkSync(parent+'-real',parent);
    } else if (kind==='world-readable') fs.chmodSync(file,0o644);
    else {
      SafeFsExecutor.safeUnlinkSync(file,{operation:'native-capture-receiver.test:replace-capture-file'});
      if (kind==='symlink') fs.symlinkSync(outside,file); else fs.linkSync(outside,file);
    }
    await expect(worker.receiveNativeCapture(caller,receipt(captureId))).rejects.toThrow();
    expect(new AcquisitionArchives(dir).hasArchive(id)).toBe(false);
    expect(fs.readFileSync(outside)).toEqual(zip);
  });
  it('rejects revoked grants, expiry and cancellation; a withdrawn connection cannot fall back to redeeming the link',async () => {
    granted=false; expect(issue).toThrow('capture-unavailable');
    granted=true; const lease=issue(); write(lease.captureId); const r=receipt(lease.captureId);
    granted=false; await expect(worker.receiveNativeCapture(caller,r)).rejects.toThrow('capture-unavailable');
    granted=true; now=lease.expires;
    await restart(); await expect(worker.receiveNativeCapture(caller,r)).rejects.toThrow('capture-unavailable');
    await restart(false); await worker.step(owner,id); expect(notice).not.toHaveBeenCalled();
    expect(worker.cancel(owner,id)).toBe(true); await restart();
    await expect(worker.receiveNativeCapture(caller,r)).rejects.toThrow();
    expect(new AcquisitionArchives(dir).hasArchive(id)).toBe(false);
  });
});
