/** Real Chrome + production native server: no synthetic queue, signer or HTTP route. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { ChromeCdpReloginBrowser, resolveChromeExecutable } from '../../src/core/ChromeCdpReloginBrowser.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import { useHermeticMediaDisk } from '../helpers/hermeticMediaDisk.js';

const TOKEN = 'outbox-browser-fixture-token';
const PIN = '482915';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const runtimeFiles = ['dashboard/console/outbox-runner.js', 'dashboard/console/chat-outbox.js', 'dashboard/console/browser-device.js', 'dashboard/console/chats-model.js', 'dashboard/console/conversations-model.js', 'src/server/mobileMediaRoutes.ts', 'src/server/mobileConversationRoutes.ts', 'src/server/mobileBrowserDevices.ts', 'src/server/mobilePairingRoutes.ts', 'src/core/MessageSentinel.ts', 'dashboard/console/chats.js', 'dashboard/console/console.css', 'dashboard/console/ui.js'];
const hashes = () => Object.fromEntries(runtimeFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const receiptDir = path.join(root, '.instar/state/build');
const dirs: string[] = [];
const browsers: ChromeCdpReloginBrowser[] = [];
const fixtures: Array<{ server: AgentServer; listener: http.Server; coordinator: MultiMachineCoordinator }> = [];
let startHashes: ReturnType<typeof hashes>;

beforeAll(() => {
  // No skipped durability claim: this proof must actually run in the supported local environment.
  expect(resolveChromeExecutable(), 'Real isolated Chrome is required for outbox acceptance').not.toBeNull();
  startHashes = hashes();
  fs.mkdirSync(receiptDir, { recursive: true });
  fs.writeFileSync(path.join(receiptDir, 'server-chrome-source-start.json'), JSON.stringify({ at: new Date().toISOString(), files: startHashes }, null, 2));
});
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close().catch(() => {});
  for (const fixture of fixtures.splice(0)) {
    fixture.listener.closeAllConnections();
    await new Promise<void>(resolve => fixture.listener.close(() => resolve()));
    await fixture.server.stop();
    fixture.coordinator.stop();
  }
  for (const dir of dirs.splice(0)) await SafeFsExecutor.safeRm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100, operation: 'web-chat-durable-outbox-alive fixture cleanup' });
}, 40_000);
afterAll(() => {
  const end = hashes();
  fs.writeFileSync(path.join(receiptDir, 'server-chrome-source-end.json'), JSON.stringify({ at: new Date().toISOString(), files: end, unchanged: JSON.stringify(end) === JSON.stringify(startHashes) }, null, 2));
  expect(end, 'Runtime changed during acceptance; rerun against the final source').toEqual(startHashes);
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-outbox-alive-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const name of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, name), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const identity = await new MachineIdentityManager(stateDir).generateIdentity({ name: 'outbox fixture machine' });
  const config = {
    projectName: 'outbox-browser-fixture', projectDir: dir, stateDir, port: 0, authToken: TOKEN, dashboardPin: PIN, developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false }, browser: { enabled: true }, native: { enabled: true, media: { enabled: true } } },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    multiMachine: { coordinationMode: 'independent' },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, tunnel: { enabled: false }, threadline: { ownerName: 'Fixture Owner' },
  } as unknown as InstarConfig;
  const effects: Array<{ kind: string; message: string }> = [];
  const manager = createMockSessionManager() as any;
  manager.on = () => undefined;
  manager.spawnInteractiveSession = async (message: string) => { effects.push({ kind: 'spawn', message }); return `fixture-session-${effects.length}`; };
  manager.injectMessage = (_name: string, message: string) => { effects.push({ kind: 'inject', message }); return true; };
  const state = new StateManager(stateDir);
  const coordinator = new MultiMachineCoordinator(state, { stateDir, multiMachine: config.multiMachine });
  coordinator.start();
  const server = new AgentServer({ config, coordinator, meshSelfId: identity.machineId, sessionManager: manager, state, initiativeTracker: new InitiativeTracker(stateDir) });
  expect(server.appConversations).not.toBeNull();
  expect(server.appConversations!.deps.requests).toBe(server.mobilePairing!.chatRequests());
  useHermeticMediaDisk(server); // the host's free space must not decide the result
  const listener = await new Promise<http.Server>((resolve, reject) => {
    const value = server.getApp().listen(0, '127.0.0.1', () => resolve(value));
    value.once('error', reject);
  });
  config.port = (listener.address() as AddressInfo).port;
  fixtures.push({ server, listener, coordinator });
  const origin = `http://localhost:${config.port}`;
  const targetRequests: Array<{ method: string; url: string }> = [];
  listener.prependListener('request', req => {
    if ((req.method === 'POST' && /^\/mobile\/(chat\/app\/|media\/uploads$)/.test(req.url || '')) || req.method === 'PUT' && /^\/mobile\/media\/uploads\//.test(req.url || '')) {
      targetRequests.push({ method: req.method!, url: req.url! });
    }
  });
  return { server, config, origin, effects, targetRequests };
}
type Fixture = Awaited<ReturnType<typeof boot>>;

async function open(fixture: Fixture, profile?: string, noLocks = false) {
  const dir = profile || fs.mkdtempSync(path.join(os.tmpdir(), 'instar-outbox-chrome-'));
  if (!profile) dirs.push(dir);
  const browser = new ChromeCdpReloginBrowser({ userDataDir: dir, headless: true, passkeyMode: true,
    launchTimeoutMs: 30_000, operationTimeoutMs: 30_000,
    originPolicy: { holderOrigin: fixture.origin, apexHost: 'localhost', allowInsecure: true } });
  browsers.push(browser);
  await browser.open(`${fixture.origin}/dashboard/console/`);
  await initialize(browser, noLocks);
  return { browser, dir };
}
async function initialize(browser: ChromeCdpReloginBrowser, noLocks = false) {
  const result = await browser.runInPage<any>(`(async()=>{try{
    window.fixtureStage='imports';
    window.bd=await import('/dashboard/console/browser-device.js');
    window.queueModule=await import('/dashboard/console/chat-outbox.js');
    window.runnerModule=await import('/dashboard/console/outbox-runner.js');
    window.fixtureState={offline:false,loseFinal:false,lost:false,accepted:null,losePuts:false,lostPutUrls:[]};
    Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>!fixtureState.offline});
    window.queueFetch=async(url,opts)=>{
      if(fixtureState.offline)throw new TypeError('Fixture transport is offline');
      const response=await fetch(url,opts);
      if(fixtureState.losePuts&&opts?.method==='PUT'&&String(url).startsWith('/mobile/media/uploads/')&&response.ok&&!fixtureState.lostPutUrls.includes(String(url))){
        fixtureState.lostPutUrls.push(String(url));
        throw new TypeError('Fixture discarded the actual durably accepted chunk response');
      }
      if(fixtureState.loseFinal&&!fixtureState.lost&&opts?.method==='POST'&&String(url).startsWith('/mobile/chat/app/')&&response.ok){
        fixtureState.accepted=await response.clone().json();fixtureState.lost=true;fixtureState.offline=true;
        throw new TypeError('Fixture discarded the actual accepted response');
      }
      return response;
    };
    window.device=bd.createBrowserDevice({bearer:()=>${JSON.stringify(TOKEN)},fetchFn:queueFetch});
    window.fixtureStage='initial status';
    const initial=await device.status(null);if(!initial.ok)throw new Error('Real browser status failed:'+JSON.stringify(initial));
    window.fixtureStage='load identity '+initial.data.machineId;
    await device.load(initial.data.machineId);
    if(!device.record){
      window.fixtureStage='PIN unlock';
      const response=await fetch('/dashboard/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:${JSON.stringify(PIN)}})});
      const unlock=await response.json();if(!response.ok)throw new Error('Fixture PIN unlock failed:'+JSON.stringify(unlock));
      window.fixtureStage='browser enrollment';
      const setup=await device.setup({askSession:async()=>unlock.operatorSessionToken,deviceName:'Isolated lifecycle browser'});
      if(!setup.ok)throw new Error('Real browser enrollment failed:'+JSON.stringify(setup));
    }
    window.fixtureStage='fresh enrolled status';
    window.support=(await device.status(device.record.keyHash)).data;
    window.store=queueModule.getChatOutbox();
    window.runner=new runnerModule.OutboxRunner({bearer:()=>${JSON.stringify(TOKEN)},fetchFn:queueFetch${noLocks ? ',locks:null' : ''}});
    window.fixtureStage='outbox bind';
    await runner.bind();
    return {active:support.key?.state,capability:support.outbox,deviceId:device.record.deviceId,privateKeyExtractable:device.record.keyPair.privateKey.extractable,locks:!!navigator.locks?.request};
    }catch(error){return {fixtureError:String(error?.message||error),stage:window.fixtureStage,stack:String(error?.stack||'')}}
  })()`);
  if(result.fixtureError)throw new Error(JSON.stringify(result));
  expect(result.active).toBe('active');
  expect(result.privateKeyExtractable).toBe(false);
  expect(result.capability).toMatchObject({ version: 1, enabled: true, text: true, media: true });
  expect(result.locks).toBe(true);
}
async function conversation(browser: ChromeCdpReloginBrowser) {
  return browser.runInPage<string>(`(async()=>{const r=await device.call('POST','/mobile/conversations',{json:{title:'Offline lifecycle fixture',requestId:bd.newRequestId(device.clock.now())}});if(!r.ok)throw new Error(JSON.stringify(r));return r.data.conversationKey})()`);
}
async function admit(browser: ChromeCdpReloginBrowser, key: string, text: string, fileText?: string) {
  return browser.runInPage<any>(`(async()=>{
    fixtureState.offline=true;
    const result=await runner.submit({record:device.record,status:support,ref:${JSON.stringify(`app:${key}`)},text:${JSON.stringify(text)},mediaRef:${JSON.stringify(`app:${key}`)},files:${fileText === undefined ? '[]' : `[new File([${JSON.stringify(fileText)}],'offline.txt',{type:'text/plain'})]`}});
    const saved=await store.list(runner.session,device.record);
    return {requestId:result.entry.requestId,admissionId:result.entry.admissionId,text:result.entry.text,files:result.entry.files,queued:saved.length};
  })()`);
}
async function settle(browser: ChromeCdpReloginBrowser) {
  return browser.runInPage<any>(`(async()=>{
    fixtureState.offline=false;await runner.reconnect();const deadline=Date.now()+20000;
    while(Date.now()<deadline){const rows=await store.list(runner.session,device.record);if(!rows.length)return {accepted:runner.lastAccepted?.data,requestId:runner.lastAccepted?.entry.requestId,files:runner.lastAccepted?.entry.files,metrics:await store.metrics(runner.session,device.record)};if(runner.error)return {runnerError:{message:String(runner.error.message||runner.error),code:runner.error.code,stack:String(runner.error.stack||'')},pending:rows};await new Promise(r=>setTimeout(r,50))}
    return {pending:await store.list(runner.session,device.record),error:String(runner.error||'')};
  })()`);
}

describe('durable web outbox — real Chrome and production native HTTP lifecycle', () => {
  it('saves offline text and file bytes, closes the full profile, and reconnects without opening the original chat', async () => {
    const fixture = await boot();
    const first = await open(fixture);
    const key = await conversation(first.browser);
    const queued = await admit(first.browser, key, 'The exact offline caption', 'The original offline file bytes.');
    expect(queued.queued).toBe(1);
    expect(queued.files).toHaveLength(1);
    expect(fixture.effects).toHaveLength(0);
    expect(fixture.targetRequests).toHaveLength(0);
    await first.browser.close();
    const reopened = await open(fixture, first.dir);
    expect(await reopened.browser.runInPage<string>('location.hash')).toBe('');
    const result = await settle(reopened.browser);
    expect(result.runnerError, JSON.stringify(result)).toBeUndefined();
    expect(result.accepted?.messageId).toBeTypeOf('string');
    expect(result.requestId).toBe(queued.requestId);
    expect(result.metrics).toMatchObject({ admitted: 1, accepted: 1 });
    expect(fixture.effects).toHaveLength(1);
    const delivered = fixture.effects[0].message;
    const longMessage = /Long message saved to (.+?) — read it/.exec(delivered)?.[1];
    if (longMessage) {
      expect(path.resolve(longMessage).startsWith(path.resolve(fixture.config.stateDir) + path.sep)).toBe(true);
      expect(fs.readFileSync(longMessage, 'utf8')).toContain('The exact offline caption');
    } else expect(delivered).toContain('The exact offline caption');
    const read = await reopened.browser.runInPage<any>(`(async()=>{
      const history=await device.call('GET',${JSON.stringify(`/mobile/chat/app/${key}/messages`)});if(!history.ok)throw new Error(JSON.stringify(history));
      const message=history.data.messages.find(m=>m.text==='The exact offline caption');
      const file=await device.signedFetch('GET','/mobile/media/'+message.attachments[0].sha256+'?ref='+encodeURIComponent(${JSON.stringify(`app:${key}`)}));
      return {verified:message.originVerified,client:message.originClient,text:message.text,filename:message.attachments[0].filename,bytes:new TextDecoder().decode(await file.arrayBuffer())};
    })()`);
    expect(read).toMatchObject({ verified: 'verified', client: 'browser', text: 'The exact offline caption', filename: 'offline.txt', bytes: 'The original offline file bytes.' });
  }, 120_000);

  it('replays a lost accepted final acknowledgment after browser restart and expired upload state without another effect', async () => {
    const fixture = await boot();
    const first = await open(fixture);
    const key = await conversation(first.browser);
    const queued = await admit(first.browser, key, 'Keep the original accepted request', 'File accepted before its acknowledgment was lost.');
    const lost = await first.browser.runInPage<any>(`(async()=>{
      fixtureState.loseFinal=true;fixtureState.offline=false;await runner.reconnect();
      const deadline=Date.now()+15000;while(!fixtureState.lost&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30));
      const rows=await store.list(runner.session,device.record);return {lost:fixtureState.lost,accepted:fixtureState.accepted,entry:rows[0]};
    })()`);
    expect(lost.lost).toBe(true);
    expect(lost.accepted.messageId).toBeTypeOf('string');
    expect(lost.entry.finalBody).toBeTypeOf('string');
    expect(fixture.effects).toHaveLength(1);
    const uploadId = lost.entry.files[0].uploadId as string;
    // Resource-loss boundary on the fixture's real SQLite store; the accepted request result remains intact.
    (fixture.server.appConversations!.media as any).db.prepare("UPDATE uploads SET state='expired', expiresAt=? WHERE uploadId=?").run(Date.now() - 1, uploadId);
    expect(fixture.server.appConversations!.media.getUpload(uploadId)?.state).toBe('expired');
    await first.browser.close();
    const reopened = await open(fixture, first.dir);
    const uploadStatus = await reopened.browser.runInPage<any>(`device.call('GET',${JSON.stringify(`/mobile/media/uploads/${uploadId}`)})`);
    expect(uploadStatus.status).toBe(410);
    const result = await settle(reopened.browser);
    expect(result.requestId).toBe(queued.requestId);
    expect(result.accepted.messageId).toBe(lost.accepted.messageId);
    expect(fixture.effects).toHaveLength(1);
    expect(fixture.targetRequests.filter(r => r.method === 'POST' && r.url === '/mobile/media/uploads')).toHaveLength(1);
    expect(fixture.targetRequests.filter(r => r.method === 'PUT')).toHaveLength(1);
  }, 120_000);

  it('coordinates two actual tabs and keeps no-lock recovery manual under the same original operation', async () => {
    const fixture = await boot();
    const first = await open(fixture);
    const key = await conversation(first.browser);
    const queued = await admit(first.browser, key, 'Two tabs, one real operation');
    await first.browser.runInPage(`(()=>{const button=document.createElement('button');button.id='open-outbox-tab';button.textContent='Open isolated second tab';button.onclick=()=>window.open('/dashboard/console/','outbox-second-tab');document.body.append(button);return true})()`);
    await first.browser.clickSelector('#open-outbox-tab');
    await first.browser.wait(350);
    await initialize(first.browser);
    const pair = await first.browser.runInPage<any>(`(async()=>{try{
      if(!window.opener)throw new Error('Actual second tab has no opener');
      window.opener.fixtureState.offline=false;fixtureState.offline=false;
      await Promise.all([runner.reconnect(),window.opener.runner.reconnect()]);
      return {one:await store.list(runner.session,device.record),two:await window.opener.store.list(window.opener.runner.session,window.opener.device.record)};
      }catch(error){return {fixtureError:String(error?.message||error),stack:String(error?.stack||'')}}
    })()`);
    expect(pair.fixtureError,JSON.stringify(pair)).toBeUndefined();
    expect(pair.one).toEqual([]);
    expect(pair.two).toEqual([]);
    expect(fixture.effects).toHaveLength(1);
    expect(fixture.targetRequests.filter(r => r.method === 'POST' && r.url.startsWith('/mobile/chat/app/'))).toHaveLength(1);
    await first.browser.runInPage(`window.opener.runner.dispose();runner.dispose();true`);
    await initialize(first.browser, true);
    const manual = await admit(first.browser, key, 'This operation requires explicit recovery');
    const before = fixture.targetRequests.length;
    await first.browser.runInPage(`(async()=>{fixtureState.offline=false;await runner.reconnect();return true})()`);
    expect(fixture.targetRequests).toHaveLength(before);
    expect(fixture.effects).toHaveLength(1);
    const completed = await first.browser.runInPage<any>(`(async()=>{const entry=(await store.list(runner.session,device.record)).find(e=>e.requestId===${JSON.stringify(manual.requestId)});await runner.resume(entry);const deadline=Date.now()+15000;while(await store.get(runner.session,device.record,entry.requestId)&&Date.now()<deadline){if(runner.error)break;await new Promise(r=>setTimeout(r,30))}return {requestId:runner.lastAccepted?.entry.requestId,data:runner.lastAccepted?.data,remaining:(await store.list(runner.session,device.record)).length,error:String(runner.error?.message||''),pending:await store.list(runner.session,device.record)}})()`);
    expect(completed.requestId,JSON.stringify(completed)).toBe(manual.requestId);
    expect(completed.data.messageId).toBeTypeOf('string');
    expect(completed.remaining).toBe(0);
    expect(fixture.effects).toHaveLength(2);
    expect(queued.requestId).not.toBe(manual.requestId);
  }, 120_000);

  it('does not release an absent old browser profile when recovery is re-enabled after another profile reviews', async () => {
    const fixture = await boot();
    const a = await open(fixture);
    const keyA = await conversation(a.browser);
    const entryA = await admit(a.browser, keyA, 'Profile A review');
    const b = await open(fixture);
    const keyB = await conversation(b.browser);
    const entryB = await admit(b.browser, keyB, 'Profile B needs its own review');
    await b.browser.close();
    fixture.config.mobilePairing!.browser!.outboxEnabled = false;
    fixture.config.mobilePairing!.browser!.outboxRecoveryGeneration = 'restore-unique-generation';
    await a.browser.runInPage(`(async()=>{fixtureState.offline=false;await runner.reconnect();return true})()`);
    expect(fixture.effects).toHaveLength(0);
    fixture.config.mobilePairing!.browser!.outboxEnabled = true;
    const reviewedA = await a.browser.runInPage<any>(`(async()=>{await runner.reconnect();const e=(await store.list(runner.session,device.record)).find(e=>e.requestId===${JSON.stringify(entryA.requestId)});await runner.resume(e);return runner.lastAccepted?.entry.requestId})()`);
    expect(reviewedA).toBe(entryA.requestId);
    expect(fixture.effects).toHaveLength(1);
    const reopenedB = await open(fixture, b.dir);
    const heldB = await reopenedB.browser.runInPage<any>(`(async()=>{await runner.reconnect();const e=(await store.list(runner.session,device.record)).find(e=>e.requestId===${JSON.stringify(entryB.requestId)});return {phase:e.phase,code:e.holdCode,requestId:e.requestId}})()`);
    expect(heldB).toEqual({ phase: 'held', code: 'generation', requestId: entryB.requestId });
    expect(fixture.effects).toHaveLength(1);
    const reviewedB = await reopenedB.browser.runInPage<any>(`(async()=>{const e=(await store.list(runner.session,device.record))[0];await runner.resume(e);return runner.lastAccepted?.entry.requestId})()`);
    expect(reviewedB).toBe(entryB.requestId);
    expect(fixture.effects).toHaveLength(2);
  }, 150_000);

  it('reconciles ten real lost chunk acknowledgments without exhausting a shared status budget or duplicating effects', async () => {
    const fixture = await boot();
    const opened = await open(fixture);
    const key = await conversation(opened.browser);
    const queued = await opened.browser.runInPage<any>(`(async()=>{
      fixtureState.offline=true;
      const bytes=new Uint8Array(9*1024*1024+13);bytes.fill(0x5a);
      const file=new File([bytes],'ten-chunks.dat',{type:'application/octet-stream'});
      const saved=await runner.submit({record:device.record,status:support,ref:${JSON.stringify(`app:${key}`)},text:'Ten chunks retain one original operation',mediaRef:${JSON.stringify(`app:${key}`)},files:[file]});
      fixtureState.losePuts=true;
      return {requestId:saved.entry.requestId,sha256:saved.entry.files[0].sha256,parts:saved.entry.files[0].partCount,size:saved.entry.files[0].size};
    })()`);
    expect(queued.parts).toBe(10);
    expect(fixture.targetRequests).toHaveLength(0);
    const accepted = await settle(opened.browser);
    expect(accepted.runnerError, JSON.stringify(accepted)).toBeUndefined();
    expect(accepted.accepted?.messageId).toBeTypeOf('string');
    expect(accepted.requestId).toBe(queued.requestId);
    expect(fixture.effects).toHaveLength(1);
    expect(fixture.targetRequests.filter(r => r.method === 'POST' && r.url === '/mobile/media/uploads')).toHaveLength(1);
    const puts = fixture.targetRequests.filter(r => r.method === 'PUT');
    expect(puts).toHaveLength(10);
    expect(new Set(puts.map(r => r.url)).size).toBe(10);
    const proof = await opened.browser.runInPage<any>(`(async()=>{
      const hash=${JSON.stringify(queued.sha256)};
      const response=await device.signedFetch('GET','/mobile/media/'+hash+'?ref='+encodeURIComponent(${JSON.stringify(`app:${key}`)}));
      const bytes=await response.arrayBuffer();
      return {downloadStatus:response.status,size:bytes.byteLength,sha256:await bd.sha256Hex(bytes),lostPuts:fixtureState.lostPutUrls.length};
    })()`);
    expect(proof).toEqual({ downloadStatus: 200, size: queued.size, sha256: queued.sha256, lostPuts: 10 });
  }, 150_000);


  it('measures the actual saved-message panel and local-file sheet at a 390px CSS viewport', async () => {
    const fixture = await boot();
    const opened = await open(fixture);
    const key = await conversation(opened.browser);
    const geometry = await opened.browser.runInPage<any>(`(async()=>{try{
      fixtureState.offline=true;
      const filename='u'.repeat(240)+'.txt';
      await runner.submit({record:device.record,status:support,ref:${JSON.stringify(`app:${key}`)},text:'A saved message stays readable on a phone. '.repeat(30),mediaRef:${JSON.stringify(`app:${key}`)},files:[new File(['Local file recovery bytes'],filename,{type:'text/plain'})]});
      localStorage.setItem('instar_token',${JSON.stringify(TOKEN)});
      const {renderChats}=await import('/dashboard/console/chats.js');
      const main=document.createElement('main');document.body.append(main);
      const page=renderChats(main,{isCurrent:()=>true});
      const deadline=Date.now()+10000;while((!page.pendingEl||page.pendingEl.hidden||!page.pendingEl.querySelector('.chat-pending-entry'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30));
      if(!page.pendingEl?.querySelector('.chat-pending-entry'))throw new Error('Actual pending-message renderer did not produce the saved entry');
      const frame=document.createElement('iframe');frame.style.width='390px';frame.style.height='800px';frame.style.border='0';document.body.append(frame);
      const doc=frame.contentDocument;const link=doc.createElement('link');link.rel='stylesheet';link.href='/dashboard/console/console.css';const ready=new Promise((resolve,reject)=>{link.onload=resolve;link.onerror=()=>reject(new Error('Actual console stylesheet failed to load'))});doc.head.append(link);await ready;
      const measure=()=>({viewport:frame.contentWindow.innerWidth,documentWidth:doc.documentElement.scrollWidth,bodyWidth:doc.body.scrollWidth,controls:[...doc.querySelectorAll('button,a.btn-quiet')].map(node=>{const r=node.getBoundingClientRect();return {text:node.textContent,width:r.width,height:r.height,left:r.left,right:r.right}})});
      doc.body.replaceChildren(doc.importNode(page.pendingEl,true));
      const panel=measure();
      const entry=page.pendingSnapshot.entries[0];await page.savePendingFiles(entry);
      const sheet=document.querySelector('.sheet-root');if(!sheet)throw new Error('Actual local-file recovery sheet was not rendered');
      const sourceLink=sheet.querySelector('a[download]');if(!sourceLink)throw new Error('Actual local-file recovery produced no download link');
      doc.body.replaceChildren(doc.importNode(sheet,true));
      const fileSheet=measure();
      const download={filename:sourceLink.download,type:sourceLink.href.startsWith('blob:'),count:sheet.querySelectorAll('a[download]').length};
      page.dispose();runnerModule.getConsoleOutbox()?.dispose();
      return {panel,fileSheet,download};
    }catch(error){return {fixtureError:String(error?.message||error),stack:String(error?.stack||'')}}})()`);
    fs.writeFileSync(path.join(receiptDir, 'server-chrome-phone-geometry.json'), JSON.stringify(geometry, null, 2));
    expect(geometry.fixtureError, JSON.stringify(geometry)).toBeUndefined();
    for (const layout of [geometry.panel, geometry.fileSheet]) {
      expect(layout.viewport).toBe(390);
      expect(layout.documentWidth, JSON.stringify(layout)).toBeLessThanOrEqual(390);
      expect(layout.bodyWidth, JSON.stringify(layout)).toBeLessThanOrEqual(390);
      for (const control of layout.controls) {
        expect(control.height, JSON.stringify(control)).toBeGreaterThanOrEqual(44);
        expect(control.left, JSON.stringify(control)).toBeGreaterThanOrEqual(0);
        expect(control.right, JSON.stringify(control)).toBeLessThanOrEqual(390);
      }
    }
    expect(geometry.download).toEqual({ filename: 'u'.repeat(240) + '.txt', type: true, count: 1 });
    expect(fixture.effects).toHaveLength(0);
    expect(fixture.targetRequests).toHaveLength(0);
  }, 120_000);

});
