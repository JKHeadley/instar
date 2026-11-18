import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DELIVERY_WINDOW_MS } from '../../src/import/acquisitionPolling.js';
import { HistoryAcquisitionStore, type ExportAccount } from '../../src/import/HistoryAcquisition.js';
import { HistoryAcquisitionWorker } from '../../src/import/HistoryAcquisitionWorker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const owner = {owner:'owner',machine:'mac',conversation:'chat'};
const account: ExportAccount = {provider:'chatgpt',workspace:'personal',expectedEmail:'owner@example.test',profileId:'dedicated'};
const dirs: string[] = [];
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'acquisition-polling-'));
  dirs.push(dir); return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'cleanup history polling test'});
});

it('reserves before publishing, retries at 0/1/3/7/15 minutes across restarts, and continues other jobs on the failing tick',async () => {
  const stateDir = directory();
  let now = 1000;
  const clock = () => now;
  const store = new HistoryAcquisitionStore(stateDir,clock);
  const warn = vi.spyOn(console,'warn').mockImplementation(() => {});
  try {
    const jobs = [0,1].map(index => {
      const chat = {...owner,conversation:'chat-'+index};
      const job = store.start(chat,{...account,expectedEmail:'owner'+index+'@example.test'},'tap');
      store.note(job.id,'attention'); return {id:job.id,chat};
    });
    const first = store.pendingNotices()[0].id;
    const retried = jobs.find(job => job.id === first)!;
    const published: Array<{id:string;at:number;key:string}> = [];
    for (let minute = 0; minute <= 30; minute++) {
      now = 1000 + minute*60_000;
      const worker = new HistoryAcquisitionWorker({stateDir,now:clock,authorized:() => true,
        connection:{available:() => [],accounts:() => [],delivery:() => undefined}});
      try {
        worker.startPolling(notice => {
          published.push({id:notice.id,at:minute,key:notice.noticeId});
          if (notice.id === first) throw new Error('private-account-detail-must-not-be-logged');
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        if (minute >= 15) expect(worker.status(retried.chat,first)).toMatchObject({phase:'ready',noticeDelivery:'exhausted'});
      } finally { await worker.close(); }
    }
    expect(published.filter(x => x.id === first).map(x => x.at)).toEqual([0,1,3,7,15]);
    expect(new Set(published.filter(x => x.id === first).map(x => x.key))).toEqual(new Set([first+'-1']));
    expect(published.filter(x => x.id !== first).map(x => x.at)).toEqual([0]);
    expect(warn.mock.calls).toEqual([['[history-acquisition] Progress delivery could not be confirmed after its final attempt. Status remains available in the private chat.']]);
    expect(store.noticeExhausted({...retried.chat,owner:'someone-else'},first)).toBe(false);
    store.note(first,'attention'); // Equivalent status cannot renew the exhausted budget.
    expect(store.pendingNotices()).toEqual([]);
    store.note(first,'waiting');
    expect(store.reserveNotice(first,1)).toBe(false);
    expect(store.pendingNotices()[0]).toMatchObject({id:first,sequence:2});
    expect(store.reserveNotice(first,2)).toBe(true);
  } finally { store.close(); }
});

it('charges interrupted reservations and emits a single exhaustion diagnostic after recovery',() => {
  const dir = directory();
  let now = 1000;
  const clock = () => now;
  let jobs = new HistoryAcquisitionStore(dir,clock);
  try {
    const {id} = jobs.start(owner,account,'tap');
    jobs.note(id,'attention');
    for (let n = 0; n < 5; n++) {
      expect(jobs.reserveNotice(id,1)).toBe(true);
      expect(jobs.reserveNotice(id,1)).toBe(false);
      jobs.close(); jobs = new HistoryAcquisitionStore(dir,clock);
      now += 60_000 * 2**n;
    }
    expect(jobs.noticeExhausted(owner,id)).toBe(true);
    expect(jobs.takeExhaustionWarnings()).toBe(1);
    jobs.close(); jobs = new HistoryAcquisitionStore(dir,clock);
    expect(jobs.reserveNotice(id,1)).toBe(false);
    expect(jobs.takeExhaustionWarnings()).toBe(0);
  } finally { jobs.close(); }
});

it('charges exactly 220 observations against a constantly undelivered export through the persisted deadline',() => {
  const dir = directory();
  let now = 0;
  const clock = () => now;
  let jobs = new HistoryAcquisitionStore(dir,clock);
  try {
    const {id} = jobs.start(owner,account,'submit');
    jobs.reserveSubmission(owner,id);
    expect(jobs.read(owner,id)?.deadline).toBe(DELIVERY_WINDOW_MS);
    const counts = [0,0,0];
    for (let minute=0; minute < DELIVERY_WINDOW_MS/60_000 + 60; minute++) {
      now = minute*60_000;
      if (minute === 90 || minute === 2000) { jobs.close(); jobs = new HistoryAcquisitionStore(dir,clock); }
      if (jobs.claimObservation(owner,id)) {
        counts[minute<120 ? 0 : minute<1440 ? 1 : 2]++;
        expect(jobs.claimObservation(owner,id)).toBe(false);
      }
    }
    expect(counts).toEqual([8,44,168]);
    expect(jobs.read(owner,id)?.phase).toBe('expired');
  } finally { jobs.close(); }
});
