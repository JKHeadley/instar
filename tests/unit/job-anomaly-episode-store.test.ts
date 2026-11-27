import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobAnomalyEpisodeStore, RECURRENCE_MUTE_MS } from '../../src/scheduler/JobAnomalyEpisodeStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
let file: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jae-store-'));
  file = path.join(dir, 'state', 'job-anomaly-episodes.json');
  clock = Date.parse('2026-10-26T00:00:00Z');
});
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-anomaly-episode-store.test.ts' }); });

describe('JobAnomalyEpisodeStore', () => {
  it('writes atomically (temp + rename) outside StateManager and leaves no temp file', () => {
    const s = new JobAnomalyEpisodeStore({ filePath: file, now });
    s.open({ machineId: 'm1', slug: 'health-check', reasonId: 'disk-low', class: 'recoverable', severity: 2, evidence: 'x' });
    expect(s.save()).toBe(true);
    const names = fs.readdirSync(path.dirname(file));
    expect(names).toEqual(['job-anomaly-episodes.json']);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const src = fs.readFileSync(path.join(__dirname, '../../src/scheduler/JobAnomalyEpisodeStore.ts'), 'utf8');
    expect(src).toContain('renameSync');
    expect(src).not.toMatch(/guardWrite\(/);
  });

  it('persists open episodes, run counters and mutes across a restart', () => {
    const a = new JobAnomalyEpisodeStore({ filePath: file, now });
    const ep = a.open({ machineId: 'm1', slug: 'health-check', reasonId: 'disk-low', class: 'recoverable', severity: 2, evidence: 'ev' });
    a.recordRun('health-check');
    a.mute(ep.key);
    a.save();
    const b = new JobAnomalyEpisodeStore({ filePath: file, now });
    expect(b.get(ep.key)?.id).toBe(ep.id);
    expect(b.runCount('health-check')).toBe(1);
    expect(b.isMuted(ep.key)).toBe(true);
    clock += RECURRENCE_MUTE_MS + 1;
    expect(b.isMuted(ep.key)).toBe(false);
  });

  it('a failed write never throws, prints one stderr line, keeps memory state', () => {
    const lines: string[] = [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(file); // a directory where the file should be ⇒ rename fails
    const s = new JobAnomalyEpisodeStore({ filePath: file, now, warn: (m) => lines.push(m) });
    const ep = s.open({ machineId: 'm1', slug: 'h', reasonId: 'disk-critical', class: 'critical', severity: 3, evidence: 'e' });
    expect(s.save()).toBe(false);
    expect(lines).toHaveLength(1);
    expect(s.failedWrites).toBe(1);
    expect(s.get(ep.key)).toBeDefined();
  });

  it('expires open episodes after 3 cron intervals without a run here', () => {
    const s = new JobAnomalyEpisodeStore({ filePath: null, now });
    s.recordRun('health-check');
    s.open({ machineId: 'm1', slug: 'health-check', reasonId: 'disk-low', class: 'recoverable', severity: 2, evidence: 'e' });
    const interval = 5 * 60_000;
    expect(s.expireStale(clock + 3 * interval, () => interval)).toHaveLength(0);
    const closed = s.expireStale(clock + 3 * interval + 1, () => interval);
    expect(closed).toHaveLength(1);
    expect(closed[0].status).toBe('stale');
    expect(closed[0].closeReason).toBe('stale: job no longer runs here');
    expect(s.listOpen()).toHaveLength(0);
  });

  it('unknown interval never expires', () => {
    const s = new JobAnomalyEpisodeStore({ filePath: null, now });
    s.open({ machineId: 'm1', slug: 'h', reasonId: 'disk-low', class: 'recoverable', severity: 2, evidence: 'e' });
    expect(s.expireStale(clock + 1e12, () => null)).toHaveLength(0);
  });

  it('counts openings within the 6 h recurrence window', () => {
    const s = new JobAnomalyEpisodeStore({ filePath: null, now });
    const k = s.key('m1', 'h', 'llm-unreliable');
    for (let i = 0; i < 3; i++) {
      s.open({ machineId: 'm1', slug: 'h', reasonId: 'llm-unreliable', class: 'recoverable', severity: 1, evidence: 'e' });
      s.close(k, 'x');
      clock += 60 * 60_000;
    }
    expect(s.openingsInWindow(k)).toBe(3);
    clock += 6 * 60 * 60_000;
    expect(s.openingsInWindow(k)).toBe(0);
  });

  it('canary namespace is isolated from real episodes in the same file', () => {
    const real = new JobAnomalyEpisodeStore({ filePath: file, now });
    real.open({ machineId: 'm1', slug: 'h', reasonId: 'disk-low', class: 'recoverable', severity: 2, evidence: 'e' });
    const canary = new JobAnomalyEpisodeStore({ filePath: null, namespace: 'canary:run-1:', now });
    const cep = canary.open({ machineId: 'm1', slug: 'h', reasonId: 'disk-low', class: 'recoverable', severity: 2, evidence: 'e' });
    expect(cep.key.startsWith('canary:run-1:')).toBe(true);
    expect(cep.key).not.toBe(real.key('m1', 'h', 'disk-low'));
    expect(canary.listOpen()).toHaveLength(1);
    expect(real.listOpen()).toHaveLength(1);
    expect(real.listOpen()[0].key.startsWith('canary:')).toBe(false);
  });
});
