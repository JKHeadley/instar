import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { jobGateReceiptPath, readJobGateReceipt, consumeJobGateReceipt, restoreJobGateReceipt } from '../../src/scheduler/JobGateReceipt.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function receipt(file: string, batchId = 'batch-1') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ batchId, consumed: false, admitted: [{ id: 'case-1', token: 'claim-receipt' }] }));
}
describe('durable gate admission handoff', () => {
  it('consumes only the expected batch and restores a failed launch without admitting a new attempt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-receipt-'));
    const file = jobGateReceiptPath(root, '../../unsafe-slug');
    try {
      expect(path.dirname(file)).toBe(path.join(root, 'state', 'job-gate-receipts'));
      expect(() => consumeJobGateReceipt(file, 'missing')).toThrow('missing');
      receipt(file);
      expect(() => consumeJobGateReceipt(file, 'changed')).toThrow('changed');
      consumeJobGateReceipt(file, 'batch-1');
      expect(readJobGateReceipt(file)?.consumed).toBe(true);
      expect(() => consumeJobGateReceipt(file, 'batch-1')).toThrow('already consumed');
      restoreJobGateReceipt(file, 'different-batch');
      expect(readJobGateReceipt(file)?.consumed).toBe(true);
      restoreJobGateReceipt(file, 'batch-1');
      expect(readJobGateReceipt(file)?.consumed).toBe(false);
      fs.writeFileSync(file, 'x'.repeat(16385));
      expect(readJobGateReceipt(file)).toBeNull();
    } finally { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'gate-receipt-test' }); }
  });
  it('carries reserved IDs in the actual spawn prompt and consumes before starting the session', async () => {
    const project = createTempProject();
    const sm = createMockSessionManager();
    const jobsFile = createSampleJobsFile(project.stateDir);
    const scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1 } as any, sm as any, project.state, project.stateDir);
    const file = jobGateReceiptPath(project.stateDir, 'receipt-job');
    let launched = 0;
    sm.spawnSession = (async opts => {
      launched++;
      expect(opts.prompt).toContain('Job gate admission receipt');
      expect(opts.prompt).toContain('case-1');
      expect(readJobGateReceipt(file)?.consumed).toBe(true);
      return { name: opts.name, id: opts.name, status: 'running' } as any;
    }) as any;
    const job = { slug: 'receipt-job', name: 'Receipt test', description: 'test', schedule: '0 0 * * *', priority: 'medium', enabled: true, expectedDurationMinutes: 1, gate: 'true', execute: { type: 'prompt', value: 'Process reserved work' } };
    try {
      receipt(file);
      (scheduler as any).spawnJobSession(job, 'test');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(launched).toBe(1);

    } finally { scheduler.stop(); project.cleanup(); }
  });
  it('keeps reservations while queued and serializes overlapping gated starts', async () => {
    const project = createTempProject();
    const sm = createMockSessionManager();
    const job = { slug: 'receipt-job', name: 'Receipt test', description: 'test', schedule: '0 0 * * *', priority: 'medium', enabled: true, expectedDurationMinutes: 1, gate: 'true', execute: { type: 'prompt', value: 'Process reserved work' } };
    const jobsFile = createSampleJobsFile(project.stateDir, [job] as any);
    const scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1 } as any, sm as any, project.state, project.stateDir);
    const file = jobGateReceiptPath(project.stateDir, job.slug);
    try {
      scheduler.refreshJobs(); receipt(file);
      sm._sessions.push({ id: 'busy', name: 'busy', jobSlug: 'other', status: 'running' } as any);
      let gateCalls = 0;
      (scheduler as any).runGateAsync = async () => { gateCalls++; await new Promise(resolve => setTimeout(resolve, 10)); return true; };
      const results = await Promise.all([scheduler.triggerJob(job.slug, 'test'), scheduler.triggerJob(job.slug, 'test')]);
      expect(results.sort()).toEqual(['queued', 'skipped']); expect(gateCalls).toBe(1);
      expect(readJobGateReceipt(file)?.consumed).toBe(false);
      sm._sessions.length = 0;
      expect(await scheduler.triggerJob(job.slug, 'queued:test')).toBe('triggered');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(readJobGateReceipt(file)?.consumed).toBe(true);
      expect(sm._spawnCount).toBe(1);
    } finally { scheduler.stop(); project.cleanup(); }
  });
  it('restores the exact reservation when launch fails before a session is accepted', async () => {
    const project = createTempProject();
    const sm = createMockSessionManager();
    const jobsFile = createSampleJobsFile(project.stateDir);
    const scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1 } as any, sm as any, project.state, project.stateDir);
    const job = { slug: 'receipt-job', name: 'Receipt test', description: 'test', schedule: '0 0 * * *', priority: 'medium', enabled: true, expectedDurationMinutes: 1, gate: 'true', execute: { type: 'prompt', value: 'Process reserved work' } };
    const file = jobGateReceiptPath(project.stateDir, job.slug);
    sm.spawnSession = async () => { throw new Error('expected launch failure'); };
    try {
      receipt(file);
      (scheduler as any).spawnJobSession(job, 'test');
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(readJobGateReceipt(file)).toMatchObject({ batchId: 'batch-1', consumed: false });
    } finally { scheduler.stop(); project.cleanup(); }
  });

});
