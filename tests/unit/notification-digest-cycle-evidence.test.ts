/**
 * CMT-2221: every daily digest cycle writes one durable, count-only row to the selectivity ledger,
 * which is what the notifications.selectivity.digest ladder counts. A quiet day still counts, a
 * failed send is recorded as harm, the digest text never enters the row, and nothing is written
 * while the digest is switched off.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationSelectivityGate } from '../../src/messaging/NotificationSelectivityGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function setup(digest: boolean, send: (text: string) => Promise<void> = async () => {}, extra: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-cycle-'));
  const gate = new NotificationSelectivityGate(root, 'test-machine', () => ({ enabled: true, dryRun: false, ...(digest ? { digest: { enabled: true } } : {}), ...extra }));
  gate.onSummary = async (text) => send(text);
  cleanup.push(async () => { await gate.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/notification-digest-cycle-evidence.test.ts' }); });
  const rows = async () => {
    await gate.close();
    const file = path.join(root, 'logs', 'notification-selectivity.jsonl');
    if (!fs.existsSync(file)) return [] as Array<Record<string, unknown>>;
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.decision === 'digest-cycle');
  };
  return { gate, rows };
}
const quiet = { origin: 'automated' as const, category: 'job-status' as const, sourceContext: 'test-source' };

describe('daily digest cycle evidence', () => {
  it('a digest that goes out writes one digest-sent row with counts only', async () => {
    const { gate, rows } = setup(true);
    await gate.route(7, 'A routine job finished with secret words.', quiet);
    await gate.tickDigest();
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ category: 'selectivity-digest', decision: 'digest-cycle', reason: 'digest-sent', total: 1, categories: 1, machineId: 'test-machine' });
    expect(JSON.stringify(r)).not.toContain('secret words');
  });

  it('a quiet day still writes a digest-empty row', async () => {
    const { gate, rows } = setup(true);
    await gate.tickDigest();
    expect((await rows()).map((r) => r.reason)).toEqual(['digest-empty']);
  });

  it('a failed send writes digest-send-failed with only the error type', async () => {
    const { gate, rows } = setup(true, async () => { throw new TypeError('chat 123 private detail'); });
    await gate.route(7, 'A routine job finished.', quiet);
    await gate.tickDigest();
    const r = await rows();
    expect(r.map((x) => [x.reason, x.error])).toEqual([['digest-send-failed', 'TypeError']]);
    expect(JSON.stringify(r)).not.toContain('private detail');
  });

  it('one cycle per day: a second tick the same day writes nothing more', async () => {
    const { gate, rows } = setup(true);
    await gate.tickDigest();
    await gate.tickDigest();
    expect(await rows()).toHaveLength(1);
  });

  it('with the digest switched off, no cycle row is written', async () => {
    const { gate, rows } = setup(false);
    await gate.route(7, 'A routine job finished.', quiet);
    await gate.tickDigest();
    expect(await rows()).toEqual([]);
  });

  it('the disk-only summary that runs with the digest off writes no cycle row', async () => {
    const sent: string[] = [];
    const { gate, rows } = setup(false, async (t) => { sent.push(t); }, { push: { categories: { 'disk-steward': false } } });
    await gate.route(7, 'Mac Studio: 40 GiB free of 926 GiB (4%).', { origin: 'automated', category: 'disk-steward', sourceContext: 'src/monitoring/DiskStewardPoster.ts' });
    await gate.tickDigest();
    expect(sent).toHaveLength(1);
    expect(await rows()).toEqual([]);
  });

  it('the ladder counts exactly these rows', () => {
    const registry = JSON.parse(fs.readFileSync('src/data/feature-ladders.json', 'utf8'));
    const entry = registry.entries.find((e: { id: string }) => e.id === 'notifications.selectivity.digest');
    const metrics = entry.rungs['dev-agent-live'].metrics as Array<{ id: string; ref: { where: Record<string, string>; of?: Record<string, string> } }>;
    expect(metrics.find((m) => m.id === 'daily-digests')?.ref.where).toEqual({ category: 'selectivity-digest', decision: 'digest-cycle' });
    expect(metrics.find((m) => m.id === 'send-failures')?.ref).toMatchObject({ where: { category: 'selectivity-digest', reason: 'digest-send-failed' }, of: { category: 'selectivity-digest', decision: 'digest-cycle' } });
    expect(entry.final).toBe('default-off-by-preference');
  });
});
