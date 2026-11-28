import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ownerAuth from '../../src/server/mobileOwnerDeviceAdmission.js';
import { HistoryAcquisitionChat } from '../../src/server/historyAcquisitionRoutes.js';
import type { MobilePairingService } from '../../src/server/mobilePairingRoutes.js';
import type { AppConversationService } from '../../src/core/AppConversationService.js';
import { ImportWriterBusy } from '../../src/import/ImportedHistoryStore.js';
import type { HistoryAcquisitionWorker } from '../../src/import/HistoryAcquisitionWorker.js';

const key = 'aaaa0000-0000-4000-8000-000000000000';
const email = 'owner@example.test';
const command = 'Bring over my personal history from Claude using ' + email;
const admitted = {deviceId:'phone',identity:{keyHash:'ledger-key',userId:null,role:'owner' as const},isCurrent:() => true};

function fixture(text = command) {
  const rawBody = Buffer.from(JSON.stringify({text,requestId:'one'}));
  const input = {kind:'message',role:'operator',senderRole:'owner',text,machineId:'local',messageId:'message-1',conversationKey:key,
    origin:{deviceId:'phone',keyHash:'ledger-key',bodyB64:rawBody.toString('base64')},receipt:{machineId:'signed-machine'}};
  const app = {deps:{signer:{machineId:() => 'signed-machine'},machineId:() => 'local'},store:{
    getMessageEvent:vi.fn((_key:string,id:string) => id === input.messageId ? input : null), append:vi.fn(),
  },verify:vi.fn(() => 'verified'),onAgentReplyAppended:vi.fn()};
  const worker = {latest:vi.fn<() => ReturnType<HistoryAcquisitionWorker['latest']>>(() => null),accounts:vi.fn(() => [{provider:'claude',expectedEmail:email}]),
    start:vi.fn(async () => ({phase:'ready'})),apply:vi.fn(),preview:vi.fn()};
  const pairing = {devices:{get:vi.fn(() => ({client:'phone'}))}};
  const chat = new HistoryAcquisitionChat(pairing as unknown as MobilePairingService, app as unknown as AppConversationService,worker as unknown as HistoryAcquisitionWorker);
  vi.spyOn(chat,'authorized').mockReturnValue(true);
  vi.spyOn(ownerAuth,'mobileOwnerDeviceAdmission').mockReturnValue(admitted);
  const req = {rawBody} as unknown as Request;
  const run = () => chat.handle(req,key,'message-1',text);
  const send = (message:string,id:string) => {
    const bytes = Buffer.from(JSON.stringify({text:message,requestId:id}));
    input.text = message;
    input.messageId = id;
    input.origin.bodyB64 = bytes.toString('base64');
    return chat.handle({rawBody:bytes} as unknown as Request,key,id,message);
  };
  return {input,app,chat,worker,run,req,pairing,send};
}
afterEach(() => vi.restoreAllMocks());

describe('history commands are bound to this saved signed message',() => {
  it('passes the signer identity, scoped owner and unique originating message to the worker', async () => {
    const f = fixture();
    expect(await f.run()).toBe('handled');
    expect(f.worker.start).toHaveBeenCalledWith({owner:'owner:default',machine:'signed-machine',conversation:key},'claude',email,'message-1');
    expect(f.app.verify).toHaveBeenCalledWith(f.input);
  });
  it.each(['redacted','unknown','failed','none'])('refuses a %s historical signature verdict',async verdict => {
    const f = fixture(); f.app.verify.mockReturnValue(verdict);
    expect(await f.run()).toBe('refused');
    expect(f.worker.start).not.toHaveBeenCalled();
    expect(f.app.store.append).not.toHaveBeenCalled();
  });
  it.each(['device','key','body','receipt','local-machine','sender','conversation','message'])('refuses a mismatched %s',async field => {
    const f = fixture();
    switch(field) {
      case 'device': f.input.origin.deviceId='other'; break;
      case 'key': f.input.origin.keyHash='other'; break;
      case 'body': f.input.origin.bodyB64=Buffer.from(JSON.stringify({text:command,requestId:'another'})).toString('base64'); break;
      case 'receipt': f.input.receipt.machineId='remote'; break;
      case 'local-machine': f.input.machineId='remote'; break;
      case 'sender': f.input.senderRole='team'; break;
      case 'conversation': f.input.conversationKey='other'; break;
      case 'message': f.input.messageId='another'; break;
    }
    expect(await f.run()).toBe('refused');
    expect(f.worker.start).not.toHaveBeenCalled();
  });
  it('rejects a browser even when it passes generic owner admission',async () => {
    const f = fixture();
    f.pairing.devices.get.mockReturnValue({client:'browser'});
    expect(await f.run()).toBe('refused');
  });
  it('checks privacy after the asynchronous worker operation and before sending its result',async () => {
    const f = fixture();
    f.worker.start.mockImplementation(async () => {
      vi.mocked(f.chat.authorized).mockReturnValue(false);
      return {phase:'ready'};
    });
    expect(await f.run()).toBe('refused');
    expect(f.app.store.append).not.toHaveBeenCalled();
  });
  it('does not re-run an already answered command against current worker state',async () => {
    const f = fixture('Preview my history import');
    f.app.store.getMessageEvent.mockImplementation((_key,id) => id === 'message-1' ? f.input : {...f.input,role:'agent'});
    expect(await f.run()).toBe('handled');
    expect(f.worker.latest).not.toHaveBeenCalled();
    expect(f.worker.preview).not.toHaveBeenCalled();
    expect(f.app.store.append).not.toHaveBeenCalled();
  });
  it('preserves confirmation only for a writer lock and refuses concurrent copies',async () => {
    const f = fixture();
    f.worker.latest.mockReturnValue({id:'job',phase:'review',provider:'claude',expectedEmail:email});
    f.worker.preview.mockResolvedValue({preview:{summary:'One chat.'},confirmation:'private-worker-token'});
    await f.send('Preview my history import','preview');
    const lastText = () => String(f.app.store.append.mock.lastCall?.[0]?.text);
    const confirm = /Copy preview [a-f0-9]{12}/.exec(lastText())![0];
    let reject!: (err: Error) => void;
    f.worker.apply.mockImplementationOnce(() => new Promise((_resolve,r) => { reject = r; }));
    const applying = f.send(confirm,'first-confirm');
    await f.send(confirm,'concurrent');
    expect(f.worker.apply).toHaveBeenCalledTimes(1);
    expect(lastText()).toContain('fresh preview');
    reject(new ImportWriterBusy());
    await applying;
    expect(lastText()).toContain(confirm);
    f.worker.apply.mockResolvedValue({messagesAdded:1});
    await f.send(confirm,'retry');
    expect(f.worker.apply).toHaveBeenCalledTimes(2);
    expect(lastText()).toContain('Copied 1 message');
    await f.send(confirm,'again');
    expect(f.worker.apply).toHaveBeenCalledTimes(2);
  });
  it('allows several devices for one owner and refuses a conversation readable by another owner profile',() => {
    const canonical = 'profile:justin';
    const devices = [
      {id:'one',status:'active',role:'owner',userId:'justin',publicKey:'a2V5'},
      {id:'two',status:'active',role:'owner',userId:'justin',publicKey:'a2V5'},
    ];
    const pairing = {devices:{list:() => devices},teamOn:() => false,grants:{all:() => ({})},teamLog:() => ({
      healthState:() => 'absent',gaps:() => [],ownerOf:() => null,isConfined:() => false,state:() => ({grants:new Map()}),
    })};
    const app = {deps:{signer:{machineId:() => 'machine'}},serves:() => true,
      store:{getConversation:() => ({createdAt:'2026-01-01T00:00:00Z',ownerPerson:null,tombstoned:false})}};
    const surface = new HistoryAcquisitionChat(pairing as unknown as MobilePairingService,app as unknown as AppConversationService,null);
    vi.spyOn(ownerAuth,'revalidateQueuedOwnerAdmissionSnapshot').mockReturnValue({ok:true});
    const chat = {owner:canonical,machine:'machine',conversation:key};
    expect(surface.authorized(chat)).toBe(true);
    devices[1].userId = 'other-owner';
    expect(surface.authorized(chat)).toBe(false);
    devices[1].status = 'revoked';
    expect(surface.authorized(chat)).toBe(true);
  });
  it('keeps an ordinary sentence outside the command handler',async () => {
    const f = fixture('What does “Bring over my personal history from Claude” do?');
    expect(await f.run()).toBe('ignored');
    expect(f.app.store.getMessageEvent).not.toHaveBeenCalled();
  });
});
