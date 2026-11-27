/**
 * Verifies PostUpdateMigrator.migrateBootBeaconFleetGraduation — the run-once strip
 * that frees a fleet agent's stale dark-default `monitoring.bootHealthBeacon.enabled:
 * false` now that the boot beacon is on for every agent (PR 3270, listen early).
 * Without it, a fleet agent that persisted the old default keeps the beacon dark with
 * no message (server.ts reads `enabled !== false`).
 *
 * Both sides: fleet `false` stripped (beacon on), dev agent `false` kept (deliberate,
 * dev-gate-teeth already freed the stale one), `true`/absent untouched, other keys
 * preserved, run-once (a re-added `false` stays), missing / corrupt config.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — boot beacon fleet graduation (listen early)', () => {
  let dir: string;
  const cfgPath = () => path.join(dir, 'config.json');
  const write = (c: unknown) => fs.writeFileSync(cfgPath(), typeof c === 'string' ? c : JSON.stringify(c, null, 2));
  const read = () => JSON.parse(fs.readFileSync(cfgPath(), 'utf-8'));
  /** The same predicate server.ts uses to start the beacon. */
  const beaconOn = (c: { monitoring?: { bootHealthBeacon?: { enabled?: boolean } } }) => c.monitoring?.bootHealthBeacon?.enabled !== false;
  function run(): MigrationResult {
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir: dir, port: 4042, hasTelegram: false, projectName: 'test' });
    (m as unknown as { migrateBootBeaconFleetGraduation(r: MigrationResult): void }).migrateBootBeaconFleetGraduation(result);
    return result;
  }

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-beacon-grad-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-bootBeaconFleetGraduation.test.ts' }); });

  it('fleet agent with the stale `false`: stripped, so the beacon starts; other keys kept; reported', () => {
    write({ monitoring: { bootHealthBeacon: { enabled: false, extra: 1 }, failureLearning: { enabled: false } } });
    expect(beaconOn(read())).toBe(false);
    const r = run();
    const c = read();
    expect(beaconOn(c)).toBe(true);
    expect(c.monitoring.bootHealthBeacon).toEqual({ extra: 1 });
    expect(c.monitoring.failureLearning).toEqual({ enabled: false });
    expect(r.upgraded.some((u) => u.includes('boot-beacon-graduation'))).toBe(true);
    expect(c._instar_migrations.some((m: string) => m.startsWith('boot-beacon-graduation-strip'))).toBe(true);
  });

  it('dev agent `false` is a deliberate off: kept', () => {
    write({ developmentAgent: true, monitoring: { bootHealthBeacon: { enabled: false } } });
    const r = run();
    expect(beaconOn(read())).toBe(false);
    expect(r.upgraded).toEqual([]);
  });

  it('absent or `true`: untouched, marker set', () => {
    write({ monitoring: { bootHealthBeacon: { enabled: true } } });
    run();
    expect(read().monitoring.bootHealthBeacon.enabled).toBe(true);
    write({ monitoring: { bootHealthBeacon: {} } });
    const r = run();
    expect(read().monitoring.bootHealthBeacon).toEqual({});
    expect(r.skipped.some((s) => s.includes('nothing to strip'))).toBe(true);
  });

  it('runs once: an owner `false` added after the migration is never re-stripped', () => {
    write({ monitoring: { bootHealthBeacon: { enabled: false } } });
    run();
    const c = read();
    c.monitoring.bootHealthBeacon.enabled = false;
    write(c);
    const r = run();
    expect(beaconOn(read())).toBe(false);
    expect(r.skipped).toContain('boot-beacon-graduation: already migrated');
  });

  it('missing config: skipped; corrupt config: error and bytes untouched', () => {
    expect(run().skipped).toContain('boot-beacon-graduation: config.json not found');
    write('{not json');
    const r = run();
    expect(r.errors.length).toBe(1);
    expect(fs.readFileSync(cfgPath(), 'utf-8')).toBe('{not json');
  });
});
