/**
 * Disk notices reach a person (docs/specs/no-data-loss-on-machine-death.md §6.2, D13).
 * On 2026-11-19 the Studio's disk warnings were held quiet by default and counted as delivered.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationSelectivityGate, categoryPushes, ownerQuietedCategory, DEFAULT_PUSH_CATEGORIES, type SelectivityConfig } from '../../src/messaging/NotificationSelectivityGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

function setup(config: SelectivityConfig) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-push-'));
  const gate = new NotificationSelectivityGate(root, 'test-machine', () => config);
  const summaries: string[] = [];
  gate.onSummary = async (text) => { summaries.push(text); };
  cleanup.push(async () => { await gate.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/notification-disk-push-default.test.ts' }); });
  return { gate, summaries };
}
const disk = { origin: 'automated' as const, category: 'disk-steward' as const, sourceContext: 'src/monitoring/DiskStewardPoster.ts' };

describe('disk notices push by default', () => {
  it('only the disk category is default-push', () => {
    expect([...DEFAULT_PUSH_CATEGORIES]).toEqual(['disk-steward']);
    expect(categoryPushes({}, 'disk-steward')).toBe(true);
    expect(categoryPushes({}, 'job-status')).toBe(false);
  });

  it('a disk post with no owner choice is pushed, not held quiet', () => {
    const { gate } = setup({ enabled: true, dryRun: false });
    const d = gate.decide(7, disk);
    expect(d.decision).toBe('deliver-push');
    expect(gate.categoryPushEnabled('disk-steward')).toBe(true);
    expect(gate.holdsCategory('disk-steward')).toBe(false);
  });

  it('an explicit owner choice to quiet disk notices still stands, and is visible as that choice', () => {
    const cfg: SelectivityConfig = { enabled: true, dryRun: false, push: { categories: { 'disk-steward': false } } };
    const { gate } = setup(cfg);
    expect(gate.decide(7, disk)).toMatchObject({ decision: 'record', reason: 'quiet-default' });
    expect(ownerQuietedCategory(cfg, 'disk-steward')).toBe(true);
    expect(gate.ownerQuieted('disk-steward')).toBe(true);
    expect(ownerQuietedCategory({ enabled: true }, 'disk-steward')).toBe(false);
  });

  it('other routine categories stay quiet by default (the boundary)', () => {
    const { gate } = setup({ enabled: true, dryRun: false });
    expect(gate.decide(7, { origin: 'automated', category: 'job-status', sourceContext: 'x' }).decision).toBe('record');
  });

  it('the daily summary runs, digest off, on a day a disk post was held quiet', async () => {
    const { gate, summaries } = setup({ enabled: true, dryRun: false, push: { categories: { 'disk-steward': false } } });
    await gate.route(7, 'Mac Studio: 40 GiB free of 926 GiB (4%).', disk);
    await gate.tickDigest();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatch(/disk space/i);
  });

  it('with the digest off and no quiet disk post, no summary is sent', async () => {
    const { gate, summaries } = setup({ enabled: true, dryRun: false });
    await gate.route(7, 'A routine job finished.', { origin: 'automated', category: 'job-status', sourceContext: 'x' });
    await gate.tickDigest();
    expect(summaries).toEqual([]);
  });
});
