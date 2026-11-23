// Real IndexedDB and CryptoKey structured cloning, isolated profile, no production browser/account.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChromeCdpReloginBrowser, resolveChromeExecutable } from '../../src/core/ChromeCdpReloginBrowser.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HAS_CHROME = resolveChromeExecutable() !== null;
const moduleSource = fs.readFileSync(new URL('../../dashboard/console/chat-outbox.js', import.meta.url), 'utf8');
const setup = `window.mod = await import('/chat-outbox.js'); window.o = mod.getChatOutbox(); window.actor = {host:location.host,machineId:'outbox-fixture',deviceId:'browser-1',keyHash:'a'.repeat(64)}; window.session = await o.bindSession();`;

describe.skipIf(!HAS_CHROME)('browser pending-send IndexedDB — real isolated Chrome', () => {
  let server: http.Server;
  let origin: string;
  const dirs: string[] = [];
  const browsers: ChromeCdpReloginBrowser[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.url === '/chat-outbox.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(moduleSource); }
      else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Isolated pending-send fixture</title>'); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  afterEach(async () => {
    for (const browser of browsers.splice(0)) await browser.close().catch(() => {});
    for (const dir of dirs.splice(0)) await SafeFsExecutor.safeRm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100, operation: 'console-chat-outbox-browser fixture cleanup' });
  });
  async function open(profile?: string) {
    const dir = profile || fs.mkdtempSync(path.join(os.tmpdir(), 'instar-chat-outbox-'));
    if (!profile) dirs.push(dir);
    const browser = new ChromeCdpReloginBrowser({ userDataDir: dir, headless: true, passkeyMode: true, launchTimeoutMs: 30_000, operationTimeoutMs: 20_000, originPolicy: { holderOrigin: origin, apexHost: 'localhost', allowInsecure: true } });
    browsers.push(browser); await browser.open(origin); await browser.runInPage(`(async()=>{${setup};return true})()`);
    return { browser, dir };
  }

  it('retains encrypted text and file parts plus a nonextractable key across closing and relaunching the same profile', async () => {
    const { browser, dir } = await open();
    const before = await browser.runInPage<any>(`(async()=>{
      window.id=Date.now()+'-'+crypto.randomUUID();
      window.entry=await o.admit(session,actor,{requestId:id,ref:'telegram:42',text:'Retain my exact message',firstSentAt:Date.now()},[new File(['photo bytes survive'], 'photo.png', {type:'image/png'})],{chunkBytes:5});
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(mod.CHAT_OUTBOX_DB,1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      const rows=await new Promise((resolve,reject)=>{const t=db.transaction(['entries','parts','keys']);const out={};for(const name of ['entries','parts','keys']){const r=t.objectStore(name).getAll();r.onsuccess=()=>out[name]=r.result}t.oncomplete=()=>resolve(out);t.onerror=()=>reject(t.error)});db.close();
      return {requestId:entry.requestId,firstSentAt:entry.firstSentAt,nonextractable:rows.keys[0].key.extractable===false,indexKeyNonextractable:rows.keys[0].indexKey.extractable===false,raw:JSON.stringify(rows.entries),partRaw:JSON.stringify(rows.parts),parts:rows.parts.length};
    })()`);
    expect(before.nonextractable).toBe(true); expect(before.indexKeyNonextractable).toBe(true);
    expect(before.raw).not.toContain('Retain my exact message'); expect(before.raw).not.toContain('telegram:42'); expect(before.raw).not.toContain('photo.png');
    expect(before.partRaw).not.toContain('photo bytes survive'); expect(before.parts).toBe(4);
    await browser.close();
    const reopened = await open(dir);
    const restored = await reopened.browser.runInPage<any>(`(async()=>{
      const entries=await o.list(session,actor);const e=entries[0];const chunks=[];for(let i=0;i<e.files[0].partCount;i++)chunks.push(new TextDecoder().decode(await o.part(session,actor,e,0,i)));
      return {length:entries.length,requestId:e.requestId,text:e.text,name:e.files[0].filename,file:chunks.join(''),firstSentAt:e.firstSentAt};
    })()`);
    expect(restored).toEqual({ length: 1, requestId: before.requestId, text: 'Retain my exact message', name: 'photo.png', file: 'photo bytes survive', firstSentAt: before.firstSentAt });
  }, 90_000);

  it('atomically fences stale progress, orders final sends, shares retry budgets and retains legacy import receipts after removal', async () => {
    const { browser } = await open();
    const result = await browser.runInPage<any>(`(async()=>{
      const id=()=>Date.now()+'-'+crypto.randomUUID();
      let first=await o.admit(session,actor,{requestId:id(),ref:'app:conversation',text:'Earlier file'});
      let later=await o.admit(session,actor,{requestId:id(),ref:'app:conversation',text:'Later correction'});
      const blocked=await o.claimAttempt(session,actor,later,'send',{final:true,now:0});
      later=await o.update(session,actor,later,{bypassPredecessorIds:[first.requestId]});
      const allowed=await o.claimAttempt(session,actor,later,'send',{final:true,now:0});
      const stale=await o.update(session,actor,later,{phase:'held'});
      let current=allowed.entry;
      for(let i=1;i<7;i++){current=await o.finishAttempt(session,actor,current,current.lastClaimToken,{nextEligibleAt:0});const c=await o.claimAttempt(session,actor,current,'send',{now:i*20000});current=c.entry}
      const exhausted=await o.claimAttempt(session,actor,current,'send',{now:200000});
      const freshStore=mod.createChatOutbox();const reloaded=await freshStore.get(session,actor,current.requestId);const stillExhausted=await freshStore.claimAttempt(session,actor,reloaded,'send',{now:300000});
      const legacyId=id();let legacy=await o.admit(session,actor,{requestId:legacyId,ref:'telegram:42',text:'Old source',phase:'held'},[],{importId:legacyId});await o.remove(session,actor,legacy);
      const importedAgain=await o.admit(session,actor,{requestId:legacyId,ref:'telegram:42',text:'Old source',phase:'held'},[],{importId:legacyId});
      const removed=await o.remove(session,actor,first,{messageId:'accepted-first',acceptedAt:first.firstSentAt+20});const resurrect=await o.update(session,actor,first,{phase:'held'});
      return {blocked:blocked.kind,allowed:allowed.kind,stale,exhausted:exhausted.kind,stillExhausted:stillExhausted.kind,importedAgain:importedAgain.alreadyImported,removed,resurrect,metrics:await o.metrics(session,actor)};
    })()`);
    expect(result).toMatchObject({ blocked: 'blocked', allowed: 'claimed', stale: null, exhausted: 'exhausted', stillExhausted: 'exhausted', importedAgain: true, removed: true, resurrect: null, metrics: { admitted: 3, accepted: 1, held: 1, acceptanceDurationMs: 20 } });
  }, 60_000);

  it('invalidates a session before failed erasure, finishes cleanup on startup and never revives a retired signing identity', async () => {
    const { browser } = await open();
    const result = await browser.runInPage<any>(`(async()=>{
      const entry=await o.admit(session,actor,{requestId:Date.now()+'-'+crypto.randomUUID(),ref:'telegram:42',text:'Must be erased'});
      const original=IDBDatabase.prototype.transaction;let writes=0;
      IDBDatabase.prototype.transaction=function(names,mode,...rest){const tx=original.call(this,names,mode,...rest);if(mode==='readwrite'&&++writes===2)queueMicrotask(()=>tx.abort());return tx};
      let failure;try{await o.clearAll()}catch(e){failure={phase:e.phase,invalidated:e.invalidated}}finally{IDBDatabase.prototype.transaction=original}
      const oldLive=await o.isLive(session);const oldClaim=await o.claimAttempt(session,actor,entry,'send').catch(e=>({kind:e.code}));
      const fresh=await o.bindSession();const rows=await o.list(fresh,actor);const legacyAllowed=await o.legacyAllowed(fresh);
      await o.clearScope(actor);let retired;try{await o.admit(fresh,actor,{requestId:Date.now()+'-'+crypto.randomUUID(),ref:'telegram:42',text:'No resurrection'})}catch(e){retired=e.code}
      const replacement={...actor,keyHash:'b'.repeat(64)};const newEntry=await o.admit(fresh,replacement,{requestId:Date.now()+'-'+crypto.randomUUID(),ref:'telegram:42',text:'Replacement is separate'});
      return {failure,oldLive,oldClaim:oldClaim.kind,rows:rows.length,legacyAllowed,retired,replacementText:newEntry.text};
    })()`);
    expect(result).toEqual({ failure: { phase: 'erase', invalidated: true }, oldLive: false, oldClaim: 'stale', rows: 0, legacyAllowed: false, retired: 'outbox-identity-retired', replacementText: 'Replacement is separate' });
  }, 60_000);

  it('aborts quota-style atomic admission without leaving an entry or parts and keeps an existing saved entry intact', async () => {
    const { browser } = await open();
    const result = await browser.runInPage<any>(`(async()=>{
      await o.admit(session,actor,{requestId:Date.now()+'-'+crypto.randomUUID(),ref:'telegram:42',text:'Already saved'});
      const original=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(value,...rest){if(this.name==='parts')throw new DOMException('Fixture disk full','QuotaExceededError');return original.call(this,value,...rest)};
      let failed;try{await o.admit(session,actor,{requestId:Date.now()+'-'+crypto.randomUUID(),ref:'telegram:42',text:'Unsaved draft'},[new File(['retain these bytes'],'keep.txt')])}catch(e){failed=e.name}finally{IDBObjectStore.prototype.put=original}
      const rows=await o.list(session,actor);return {failed,texts:rows.map(e=>e.text)};
    })()`);
    expect(result).toEqual({ failed: 'QuotaExceededError', texts: ['Already saved'] });
  }, 60_000);
  it('coalesces concurrent admission, rejects changed file bytes under the same ID and never prunes beyond fifty rows', async () => {
    const { browser } = await open();
    const result = await browser.runInPage<any>(`(async()=>{
      const requestId=Date.now()+'-'+crypto.randomUUID();const input={requestId,ref:'telegram:42',text:'One immutable send',path:'/mobile/chat/42'};
      const sibling=mod.createChatOutbox();
      const pair=await Promise.all([o.admit(session,actor,input,[new File(['first'],'same.txt')]),sibling.admit(session,actor,input,[new File(['first'],'same.txt')])]);
      let changed;try{await o.admit(session,actor,input,[new File(['other'],'same.txt')])}catch(e){changed=e.code}
      for(let i=0;i<51;i++)await o.admit(session,actor,{requestId:Date.now()+'-'+crypto.randomUUID(),ref:'telegram:42',text:'Queued '+i});
      const rows=await o.list(session,actor);return {sameAdmission:pair[0].admissionId===pair[1].admissionId,changed,count:rows.length,metrics:await o.metrics(session,actor)};
    })()`);
    expect(result).toMatchObject({ sameAdmission: true, changed: 'outbox-request-id-reused', count: 52, metrics: { admitted: 52, failure: 1 } });
  }, 60_000);

  it('keeps the server cooldown across an explicit retry and admits the same original request only when it expires', async () => {
    const { browser } = await open();
    const result = await browser.runInPage<any>(`(async()=>{
      const now=Date.now();const requestId=now+'-'+crypto.randomUUID();
      let entry=await o.admit(session,actor,{requestId,ref:'telegram:42',text:'Retry this exact original'});
      const finalBody=JSON.stringify({text:entry.text,requestId});
      entry=await o.update(session,actor,entry,{finalPath:'/mobile/chat/42',finalBody});
      const claim=await o.claimAttempt(session,actor,entry,'final',{now,final:true});
      const cooldown=now+180000;
      entry=await o.finishAttempt(session,actor,claim.entry,claim.token,{nextEligibleAt:cooldown,patch:{phase:'submitted'}});
      const reset=await o.resetAttempts(session,actor,entry,{now:now+1000});
      const before=await o.claimAttempt(session,actor,reset,'final',{now:now+2000,final:true});
      const freshStore=mod.createChatOutbox();entry=await freshStore.get(session,actor,requestId);
      const at=await freshStore.claimAttempt(session,actor,entry,'final',{now:cooldown,final:true});
      return {before:before.kind,notBefore:before.nextEligibleAt,expectedCooldown:cooldown,at:at.kind,count:at.entry?.attempts.final.count,requestId:at.entry?.requestId,original:requestId,body:at.entry?.finalBody,expectedBody:finalBody};
    })()`);
    expect(result.before).toBe('wait');
    expect(result.notBefore).toBe(result.expectedCooldown);
    expect(result.at).toBe('claimed'); expect(result.count).toBe(1);
    expect(result.requestId).toBe(result.original); expect(result.body).toBe(result.expectedBody);
  }, 60_000);

});
