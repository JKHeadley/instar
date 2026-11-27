import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { Readable } from 'node:stream';
import { HistoryAcquisitionStore } from '../../src/import/HistoryAcquisition.js';
import { AcquisitionArchives } from '../../src/import/archiveStaging.js';
import { AcquisitionWorkerLease } from '../../src/import/AcquisitionWorkerLease.js';
import { historyApp } from '../helpers/historyAcquisitionApp.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

it('reports unsafe preview staging on the production boot path while keeping owner history readable', async () => {
  const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => {});
  let h: Awaited<ReturnType<typeof historyApp>> | undefined;
  try {
    h = await historyApp(undefined, stateDir => {
      fs.writeFileSync(path.join(stateDir, 'import-preview-staging'), 'synthetic unsafe staging');
    });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ feature: 'ImportedHistory.stagingCleanup', internalOnly: true }));
    expect(JSON.stringify(report.mock.calls.filter(([entry]) => entry.feature === 'ImportedHistory.stagingCleanup'))).not.toContain(h.stateDir);
    expect((await h.send('GET', '/mobile/imported-history/conversations')).status).toBe(200);
  } finally { await h?.close(); report.mockRestore(); }
});

it('boots with an empty signed capability and no acquisition storage; owner chat explains the fallback',async () => {
  const h = await historyApp();
  const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => {});
  const cap = '/mobile/imported-history/capabilities';
  try {
    const out = await h.send('GET',cap);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({acquisition:{version:1,providers:[]}});
    expect(report).not.toHaveBeenCalledWith(expect.objectContaining({
      feature: 'HistoryAcquisition.providerDiscovery',
    }));
    expect((await h.auth(request(h.app).get(cap))).status).toBe(403);
    expect((await request(h.app).get(cap).set('X-Instar-Device',h.deviceId)).status).toBeGreaterThanOrEqual(400);
    const key = await h.create();
    expect((await h.say(key,'Bring over my personal history from Claude')).body.outcome).toBe('intercepted');
    const messages = await h.messages(key);
    expect(messages[0].originVerified).toBe('verified');
    expect(messages[1].text).toContain('use an existing export file');
    expect(fs.existsSync(path.join(h.stateDir,'history-acquisition'))).toBe(false);
  } finally {
    report.mockRestore();
    await h.close();
  }
});

it('keeps ordinary routes available when the pilot cannot open its worker lease',async () => {
  let lease: AcquisitionWorkerLease | undefined;
  const offline = {available:() => ['claude' as const],accounts:() => [],delivery:() => undefined};
  const h = await historyApp(offline,stateDir => { lease = new AcquisitionWorkerLease(stateDir); });
  try {
    const result = await h.send('GET','/mobile/imported-history/capabilities');
    expect(result.status).toBe(200);
    expect(result.body.acquisition.providers).toEqual([]);
    expect((await h.send('GET','/mobile/conversations')).status).toBe(200);
  } finally { lease?.close(); await h.close(); }
});

it('cleans up an expired private archive on reboot after the connection has been withdrawn',async () => {
  const chat = {owner:'owner:default',conversation:'expired-fixture',machine:'fixture-machine'};
  let id: string;
  const waitingChat = {...chat,conversation:'still-waiting'};
  const h = await historyApp(undefined,async stateDir => {
    const old = Date.now() - 8*24*60*60_000;
    const jobs = new HistoryAcquisitionStore(stateDir,() => old);
    try {
      const job = jobs.start(chat,{provider:'claude',profileId:'pilot',workspace:'personal',expectedEmail:'owner@example.test'},'first');
      id = job.id;
      expect(jobs.reserveSubmission(chat,id)).toBe(true);
      const archives = new AcquisitionArchives(stateDir);
      const receipt = await archives.stage(id,Readable.from(Buffer.from('fixture')));
      expect(jobs.review(chat,id,receipt.sha256)).toBe(true);
      expect(archives.hasArchive(id)).toBe(true);
    } finally { jobs.close(); }
    const current = new HistoryAcquisitionStore(stateDir);
    try {
      const pending = current.start(waitingChat,{provider:'claude',profileId:'pilot',workspace:'personal',expectedEmail:'waiting@example.test'},'second');
      expect(current.reserveSubmission(waitingChat,pending.id)).toBe(true);
      expect(current.acknowledge(waitingChat,pending.id)).toBe(true);
    } finally { current.close(); }
  });
  try {
    const result = await h.send('GET','/mobile/imported-history/capabilities');
    expect(result.status).toBe(200);
    expect(result.body.acquisition.providers).toEqual([]);
    expect(new AcquisitionArchives(h.stateDir).hasArchive(id!)).toBe(false);
    const jobs = new HistoryAcquisitionStore(h.stateDir);
    try {
      expect(jobs.latest(chat)?.phase).toBe('expired');
      expect(jobs.latest(waitingChat)?.phase).toBe('waiting');
    } finally { jobs.close(); }
  } finally { await h.close(); }
});
