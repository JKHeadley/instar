import { expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { historyApp } from '../helpers/historyAcquisitionApp.js';
import { makeZip } from '../helpers/exportZip.js';
import { HistoryAcquisitionStore } from '../../src/import/HistoryAcquisition.js';
import { AcquisitionArchives } from '../../src/import/archiveStaging.js';
import { ImportedHistoryStore } from '../../src/import/ImportedHistoryStore.js';
import { HistoryAcquisitionChat } from '../../src/server/historyAcquisitionRoutes.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

it('keeps provider discovery closed and reports an internal diagnostic when proof lookup fails', async () => {
  const privateError = 'private-provider-fixture@example.test';
  const h = await historyApp({
    available: () => { throw new Error(privateError); },
    accounts: () => [],
    delivery: () => undefined,
  });
  const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => {});
  try {
    const response = await h.send('GET', '/mobile/imported-history/capabilities');
    expect(response.status).toBe(200);
    expect(response.body.acquisition.providers).toEqual([]);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'HistoryAcquisition.providerDiscovery',
      reason: 'provider-proof-unavailable',
      internalOnly: true,
    }));
    expect(JSON.stringify(report.mock.calls)).not.toContain(privateError);
  } finally {
    report.mockRestore();
    await h.close();
  }
});

it('uses a real signed owner message, stops at missing delivery permission, and copies a staged fixture only on distinct preview consent',async () => {
  const email = 'pilot@example.test';
  const h = await historyApp({
    available:() => ['chatgpt'],
    accounts:() => [{provider:'chatgpt',profileId:'dedicated-pilot',expectedEmail:email,workspace:'personal'}],
    delivery:() => undefined,
  });
  const jobs = new HistoryAcquisitionStore(h.stateDir);
  try {
    const cap = await h.send('GET','/mobile/imported-history/capabilities');
    expect(cap.body.acquisition.providers).toEqual(['chatgpt']);
    const key = await h.create();
    const chat = {conversation:key,owner:'owner:default',machine:h.server.appConversations!.deps.signer!.machineId()};
    const prompt = 'Bring over my personal history from ChatGPT';
    expect((await h.say(key,prompt)).status).toBe(200);
    expect((await h.messages(key)).at(-1)?.text).toContain(email);
    expect(jobs.latest(chat)).toBeNull();
    const id = Date.now() + '-' + crypto.randomUUID();
    const choose = () => h.say(key,prompt + ' using ' + email,id);
    const sent = await choose();
    expect(sent.body.outcome).toBe('intercepted');
    const job = jobs.latest(chat)!;
    expect(job.phase).toBe('ready');
    await choose();
    expect(jobs.latest(chat)!.id).toBe(job.id);
    expect((await h.messages(key)).filter(x => x.role === 'agent')).toHaveLength(2);
    await h.say(key,'Bring over my personal history from Claude');
    expect((await h.messages(key)).at(-1)?.text).toContain('current import is for ChatGPT, personal workspace, ' + email);
    expect(jobs.latest(chat)!.id).toBe(job.id);
    expect((await h.say(key,'Resume my history import')).status).toBe(200);
    expect((await h.messages(key)).at(-1)?.text).toContain('Grant access to the export delivery');
    // Provider and mailbox are offline in this test. Stage a local synthetic receipt at the worker boundary.
    expect(jobs.reserveSubmission(chat,job.id)).toBe(true);
    const archive = makeZip([{name:'chat.html',data:''},{name:'user.json',data:JSON.stringify({email})},{name:'conversations.json',data:JSON.stringify([{
      conversation_id:'c1',title:'fixture',current_node:'m',mapping:{m:{id:'m',parent:null,children:[],message:{id:'m',author:{role:'user'},content:{parts:['hello']},create_time:1740823200}}},
    }])}]);
    const receipt = await new AcquisitionArchives(h.stateDir).stage(job.id,Readable.from(archive));
    expect(jobs.review(chat,job.id,receipt.sha256)).toBe(true);
    const history = new ImportedHistoryStore(h.stateDir);
    expect((await h.say(key,'Preview my history import')).status).toBe(200);
    const preview = (await h.messages(key)).at(-1)!.text;
    expect(preview).toContain('personal workspace, ' + email);
    expect(preview).toContain('1 chat');
    const consent = /Copy preview [0-9a-f]{12}/.exec(preview)![0];
    const other = await h.create();
    await h.say(other,consent);
    await h.say(key,'Copy preview ' + (consent.endsWith('000000000000') ? 'ffffffffffff' : '000000000000'));
    expect(history.listConversations()).toHaveLength(0);
    await h.say(key,'Preview my history import');
    const fresh = /Copy preview [0-9a-f]{12}/.exec((await h.messages(key)).at(-1)!.text)![0];
    await h.say(key,consent);
    expect(jobs.latest(chat)!.phase).toBe('review');
    const pairing = h.server.mobilePairing!;
    pairing.grants.set('msp-pilot',{ownerConversations:true},h.deviceId);
    expect((await h.send('GET','/mobile/imported-history/capabilities')).body.acquisition.providers).toEqual([]);
    expect((await h.say(key,fresh)).status).toBe(403);
    expect(jobs.latest(chat)!.phase).toBe('review');
    pairing.grants.set('msp-pilot',{ownerConversations:false},h.deviceId);
    await history.withWriter(async () => {
      const busy = await h.say(key,fresh);
      expect(busy.status).toBe(200);
      expect((await h.messages(key)).at(-1)?.text).toContain('send this line again');
    });
    expect(jobs.latest(chat)!.phase).toBe('review');
    await h.say(key,fresh);
    expect(jobs.latest(chat)!.phase).toBe('complete');
    expect(new ImportedHistoryStore(h.stateDir).listConversations()).toHaveLength(1);
    await h.say(key,prompt + ' using ' + email);
    await h.say(key,'Cancel my history import');
    expect(jobs.latest(chat)!.phase).toBe('cancelled');
  } finally { jobs.close(); await h.close(); }
});

it('keeps progress on the currently owned private conversation and deduplicates app notifications',async () => {
  const h = await historyApp();
  try {
    const key = await h.create();
    const pairing = h.server.mobilePairing!;
    const app = h.server.appConversations!;
    const chat = {owner:'owner:default',machine:app.deps.signer!.machineId(),conversation:key};
    const surface = new HistoryAcquisitionChat(pairing,app,null);
    const notice = {id:'fixture',noticeId:'fixture-1',text:'Your provider accepted the export request.',chat};
    const notified = vi.spyOn(app,'onAgentReplyAppended');
    surface.publish(notice);
    surface.publish(notice);
    expect(notified).toHaveBeenCalledTimes(1);
    const team = pairing.teamLog()!;
    const state = team.state();
    const shared = vi.spyOn(team,'state').mockReturnValue({...state,grants:new Map([['member',new Map([[key,'read']])]])});
    expect(surface.authorized(chat)).toBe(false);
    expect(() => surface.publish({...notice,noticeId:'fixture-2'})).toThrow();
    shared.mockRestore();
    expect(surface.authorized({...chat,machine:'former-machine'})).toBe(false);
    expect(surface.authorized({...chat,owner:'profile:other'})).toBe(false);
    vi.spyOn(app,'serves').mockReturnValue(false);
    expect(surface.authorized(chat)).toBe(false);
    expect(notified).toHaveBeenCalledTimes(1);
  } finally { await h.close(); }
});
