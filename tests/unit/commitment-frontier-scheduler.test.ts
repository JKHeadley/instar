import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { commitmentRig, normalBody, frontierSource } from '../helpers/commitment-frontier.js';

const rigs: ReturnType<typeof commitmentRig>[] = [];
afterEach(() => { for (const rig of rigs.splice(0)) rig.close(); });
function make(flags?: { enabled?: boolean; skipEnabled?: boolean }) { const rig = commitmentRig(flags); rigs.push(rig); return rig; }

describe('commitment frontier scheduler wiring', () => {
  it('default off preserves prompt and makes no receipt state', async () => {
    const rig = make({});
    expect(await rig.scheduler.triggerJob('commitment-detection', 'test')).toBe('triggered'); await rig.settle();
    expect(rig.sessions._lastSpawnArgs!.prompt).toContain(normalBody);
    expect(rig.sessions._lastSpawnArgs!.prompt).not.toContain('Optional commitment coverage');
    expect(fs.existsSync(path.join(rig.project.stateDir, 'state', 'commitment-frontier'))).toBe(false);
  });
  it('maxParallelJobs=1 excludes its own reservation; collection stays dark until separate opt-in', async () => {
    const rig = make();
    expect(await rig.scheduler.triggerJob('commitment-detection', 'test')).toBe('triggered');
    await rig.finish();
    expect(rig.sessions._lastSpawnArgs!.prompt).toContain(normalBody);
    expect(rig.sessions._lastSpawnArgs!.prompt).toContain('Optional commitment coverage');
    expect(await rig.scheduler.triggerJob('commitment-detection', 'test')).toBe('triggered');
    await rig.finish();
    rig.setFlags({ enabled: true, skipEnabled: true });
    expect(await rig.scheduler.triggerJob('commitment-detection', 'test')).toBe('skipped');
    expect(rig.sessions._spawnCount).toBe(2);
    fs.appendFileSync(path.join(rig.project.stateDir, 'telegram-messages.jsonl'), frontierSource('2'));
    expect(await rig.scheduler.triggerJob('commitment-detection', 'test')).toBe('triggered');
    expect(rig.sessions._spawnCount).toBe(3);
  });
  it('nonterminal callback cannot consume, clean or falsely complete the receipt run', async () => {
    const rig = make(); await rig.scheduler.triggerJob('commitment-detection', 'test'); await rig.settle();
    const session = rig.sessions._sessions[0];
    await rig.scheduler.notifyJobComplete(session.id, session.tmuxSession);
    expect(rig.project.state.getJobState('commitment-detection')!.lastResult).toBe('pending');
    expect(rig.batch().value.rows).toHaveLength(1);
    await rig.finish(); rig.setFlags({ enabled: true, skipEnabled: true });
    expect(await rig.scheduler.triggerJob('commitment-detection', 'test')).toBe('skipped');
  });
  it('concurrent calls serialize even without an ordinary shell gate', async () => {
    const rig = make();
    const results = await Promise.all([rig.scheduler.triggerJob('commitment-detection', 'a'), rig.scheduler.triggerJob('commitment-detection', 'b')]);
    expect(results.sort()).toEqual(['skipped', 'triggered']); expect(rig.sessions._spawnCount).toBe(1);
  });
  it.each(['demote', 'disable', 'definition'])('rechecks %s after asynchronous source/action reads', async (change) => {
    const rig = make(); let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    rig.scheduler.setCommitmentFrontierActionReader(async () => { entered(); await waiting; return []; });
    const fire = rig.scheduler.triggerJob('commitment-detection', 'test'); await started;
    if (change === 'demote') rig.project.state.setReadOnly(true);
    if (change === 'disable') fs.writeFileSync(rig.jobsFile, JSON.stringify([{ ...rig.job, enabled: false }]));
    if (change === 'definition') fs.writeFileSync(rig.jobsFile, JSON.stringify([{ ...rig.job, body: 'changed' }]));
    release(); expect(await fire).toBe('skipped'); expect(rig.sessions._spawnCount).toBe(0);
    rig.project.state.setReadOnly(false);
  });
  it('a spawn rejection discards only its batch and releases its reservation', async () => {
    const rig = make(); rig.sessions.spawnSession = vi.fn().mockRejectedValue(new Error('fixture failure'));
    expect(await rig.scheduler.triggerJob('commitment-detection', 'test')).toBe('triggered'); await rig.settle();
    const dir = path.join(rig.project.stateDir, 'state', 'commitment-frontier', 'batches');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(rig.scheduler.getStatus().activeJobSessions).toBe(0);
  });
});

describe('receipt lifecycle admission fences', () => {
  it('unknown final role proof suppresses a previously valid skip', async () => {
    const rig = make(); await rig.scheduler.triggerJob('commitment-detection', 'first'); await rig.finish();
    rig.setFlags({ enabled: true, skipEnabled: true }); let reads = 0;
    rig.scheduler.setRoleGuard(() => { if (++reads === 3) throw new Error('fixture authority read failed'); return { enabled: true, holdsLease: true }; });
    expect(await rig.scheduler.triggerJob('commitment-detection', 'uncertain-role')).toBe('triggered');
    expect(rig.sessions._spawnCount).toBe(2);
  });
  it.each(['keep-owner', 'demote', 'remove-definition'])('holds same-slug fence through deferred completion and preserves cleanup: %s', async (kind) => {
    const rig = make(); await rig.scheduler.triggerJob('commitment-detection', 'first'); await rig.settle();
    const captured = rig.batch(); const session = rig.sessions._sessions[0];
    fs.writeFileSync(captured.ackPath, JSON.stringify({ version: 1, batchId: captured.value.batchId,
      sessionName: session.name, batchHash: captured.hash,
      decisions: captured.value.rows.map((r: { key: string }) => ({ key: r.key, outcome: 'reviewed-no-action' })) }));
    session.status = 'completed'; rig.project.state.saveSession(session);
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    rig.scheduler.setCommitmentFrontierActionReader(async () => { entered(); await wait; return []; });
    const releaseClaim = vi.spyOn(rig.scheduler as any, 'releaseClaim');
    const completion = rig.scheduler.notifyJobComplete(session.id, session.tmuxSession); await started;
    expect(releaseClaim).toHaveBeenCalledTimes(1);
    expect(await rig.scheduler.triggerJob('commitment-detection', 'concurrent')).toBe('skipped');
    expect(rig.sessions._spawnCount).toBe(1);
    if (kind === 'demote') rig.project.state.setReadOnly(true);
    if (kind === 'remove-definition') {
      fs.writeFileSync(rig.jobsFile, '[]'); (rig.scheduler as any).refreshJobs();
      await rig.scheduler.notifyJobComplete(session.id, session.tmuxSession);
      expect(releaseClaim).toHaveBeenCalledTimes(1);
      expect((rig.scheduler as any).frontierBatches.size).toBe(1);
    }
    release(); await expect(completion).resolves.toBeUndefined();
    rig.project.state.setReadOnly(false); fs.writeFileSync(rig.jobsFile, JSON.stringify([rig.job])); rig.scheduler.setCommitmentFrontierActionReader(() => []);
    expect(await rig.scheduler.triggerJob('commitment-detection', 'next')).toBe('triggered');
    expect(rig.sessions._spawnCount).toBe(2); expect(releaseClaim).toHaveBeenCalledTimes(1);
  });
  it('does not reconcile a terminal batch after demotion to standby', async () => {
    const rig = make(); await rig.scheduler.triggerJob('commitment-detection', 'first'); await rig.settle();
    const session = rig.sessions._sessions[0]; session.status = 'completed'; rig.project.state.saveSession(session);
    rig.project.state.setReadOnly(true);
    const save = vi.spyOn(rig.project.state, 'saveJobState');
    await expect(rig.scheduler.triggerJob('commitment-detection', 'standby')).resolves.toBe('skipped');
    expect(save).not.toHaveBeenCalled(); expect(rig.sessions._spawnCount).toBe(1);
    expect(fs.existsSync(path.join(rig.project.stateDir, 'state', 'commitment-frontier', 'receipt.sqlite'))).toBe(false);
    rig.project.state.setReadOnly(false);
  });
  it('an original delayed callback cannot complete or release a newer run', async () => {
    const rig = make(); await rig.scheduler.triggerJob('commitment-detection', 'first'); await rig.settle();
    const old = rig.sessions._sessions[0]; old.status = 'completed'; rig.project.state.saveSession(old);
    const release = vi.spyOn(rig.scheduler as any, 'releaseClaim');
    expect(await rig.scheduler.triggerJob('commitment-detection', 'reconcile-and-run')).toBe('triggered'); await rig.settle();
    expect(release).toHaveBeenCalledTimes(1);
    expect(rig.project.state.getJobState('commitment-detection')!.lastResult).toBe('pending');
    await rig.scheduler.notifyJobComplete(old.id, old.tmuxSession);
    expect(release).toHaveBeenCalledTimes(1);
    expect(rig.project.state.getJobState('commitment-detection')!.lastResult).toBe('pending');
    expect(rig.sessions._spawnCount).toBe(2);
  });
  it('cleans an exact terminal run whose definition disappeared, then permits re-addition', async () => {
    const rig = make(); await rig.scheduler.triggerJob('commitment-detection', 'first'); await rig.settle();
    fs.writeFileSync(rig.jobsFile, '[]'); (rig.scheduler as any).refreshJobs();
    const old = rig.sessions._sessions[0]; old.status = 'completed'; rig.project.state.saveSession(old);
    const release = vi.spyOn(rig.scheduler as any, 'releaseClaim');
    await rig.scheduler.notifyJobComplete(old.id, old.tmuxSession);
    expect(release).toHaveBeenCalledTimes(1);
    expect((rig.scheduler as any).frontierBatches.size).toBe(0);
    expect((rig.scheduler as any).activeRunIds.size).toBe(0);
    fs.writeFileSync(rig.jobsFile, JSON.stringify([rig.job]));
    expect(await rig.scheduler.triggerJob('commitment-detection', 're-added')).toBe('triggered');
    expect(rig.sessions._spawnCount).toBe(2);
  });
  it('a delayed terminal event is reconciled once without discarding its legitimate acknowledgement', async () => {
    const rig = make(); await rig.scheduler.triggerJob('commitment-detection', 'first'); await rig.settle();
    const captured = rig.batch(); const session = rig.sessions._sessions[0];
    fs.writeFileSync(captured.ackPath, JSON.stringify({ version: 1, batchId: captured.value.batchId,
      sessionName: session.name, batchHash: captured.hash,
      decisions: captured.value.rows.map((r: { key: string }) => ({ key: r.key, outcome: 'reviewed-no-action' })) }));
    session.status = 'completed'; rig.project.state.saveSession(session); rig.setFlags({ enabled: true, skipEnabled: true });
    expect(await rig.scheduler.triggerJob('commitment-detection', 'next')).toBe('skipped');
    expect(rig.sessions._spawnCount).toBe(1);
    expect(fs.existsSync(path.join(rig.project.stateDir, 'state', 'commitment-frontier', 'receipt.sqlite'))).toBe(true);
  });
});
