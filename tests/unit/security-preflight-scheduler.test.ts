import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { securityRig, securityBody } from '../helpers/security-preflight.js';
import { SecurityReviewPreflight, verifyPacketSource } from '../../src/scheduler/SecurityReviewPreflight.js';
const rigs: ReturnType<typeof securityRig>[] = [];
function make(enabled = true) { const r = securityRig(enabled); rigs.push(r); return r; }
afterEach(() => { vi.restoreAllMocks(); for (const r of rigs.splice(0)) r.close(); });
describe('security preflight scheduler wiring', () => {
  it('off preserves the exact same normal dispatched prompt and creates no output', async () => {
    const r = make(false); expect(await r.scheduler.triggerJob('security-review', 'fixture')).toBe('triggered');
    await vi.waitFor(() => expect(r.sessions._spawnCount).toBe(1));
    const expected = r.sessions._lastSpawnArgs!.prompt; expect(expected).toContain(securityBody);
    expect(fs.existsSync(r.packetDir)).toBe(false);
    const s = r.sessions._sessions[0]; s.status = 'completed'; r.project.state.saveSession(s);
    await r.scheduler.notifyJobComplete(s.id, s.tmuxSession); await new Promise(resolve => setImmediate(resolve)); r.setEnabled(true);
    expect(await r.scheduler.triggerJob('security-review', 'fixture')).toBe('triggered');
    await vi.waitFor(() => expect(r.packets()).toHaveLength(1));
    const p = r.packets()[0]; expect(verifyPacketSource(p.sources[3])!.toString()).toBe(r.sessions._lastSpawnArgs!.prompt);
    expect(r.sessions._lastSpawnArgs!.prompt).toBe(expected); expect(p.binding.sessionId).toBe(r.sessions._sessions[1].id);
    expect(r.sessions._lastSpawnArgs!.model).toBe('opus'); expect(r.sessions._spawnCount).toBe(2);
  });
  it('an unavailable source leaves normal review pending and reports no private content', async () => {
    const r = make(); fs.renameSync(r.ledger, r.ledger + '.away');
    expect(await r.scheduler.triggerJob('security-review', 'fixture')).toBe('triggered');
    await vi.waitFor(() => expect(r.sessions._spawnCount).toBe(1));
    expect(r.project.state.getJobState('security-review')!.lastResult).toBe('pending');
    await vi.waitFor(() => expect(r.project.state.queryEvents({ type: 'security_review_preflight' }).length).toBe(1));
    const events = r.project.state.queryEvents({ type: 'security_review_preflight' });
    expect(JSON.stringify(events)).not.toContain('Duplicate headings'); expect(r.packets()).toEqual([]);
  });
  it('slow/rejected diagnostic work cannot hold normal admission or add a model session', async () => {
    const r = make(); let reject!: (error: Error) => void;
    const waiting = new Promise<never>((_resolve, fail) => { reject = fail; });
    const capture = vi.spyOn(SecurityReviewPreflight.prototype, 'capture').mockReturnValue(waiting);
    await expect(r.scheduler.triggerJob('security-review', 'fixture')).resolves.toBe('triggered');
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(r.project.state.getJobState('security-review')!.lastResult).toBe('pending');
    reject(new Error('fixture failure')); await new Promise(resolve => setImmediate(resolve));
    expect(r.sessions._spawnCount).toBe(1); expect(r.sessions._lastSpawnArgs!.prompt).toContain(securityBody);
  });
});
