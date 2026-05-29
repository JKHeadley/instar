/**
 * Tier-1 tests for the stage-write guard (§Rollout, Structure > Willpower): the
 * rollout stage is StageAdvancer-write-only. A direct LiveConfig write to the stage
 * path is refused with stage-write-not-permitted unless it carries the capability
 * token; any other config path is unaffected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { STAGE_CONFIG_PATH, STAGE_WRITE_TOKEN, assertStageWriteAuthorized, StageWriteNotPermittedError } from '../../src/config/stageWriteGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('stageWriteGuard (§Rollout)', () => {
  it('throws on a stage write WITHOUT the token', () => {
    expect(() => assertStageWriteAuthorized(STAGE_CONFIG_PATH)).toThrow(StageWriteNotPermittedError);
    expect(() => assertStageWriteAuthorized(STAGE_CONFIG_PATH, Symbol('forged'))).toThrow(/stage-write-not-permitted|not permitted/);
  });
  it('allows a stage write WITH the token', () => {
    expect(() => assertStageWriteAuthorized(STAGE_CONFIG_PATH, STAGE_WRITE_TOKEN)).not.toThrow();
  });
  it('is a no-op for any other config path (token or not)', () => {
    expect(() => assertStageWriteAuthorized('updates.autoApply', undefined)).not.toThrow();
    expect(() => assertStageWriteAuthorized('multiMachine.sessionPool.enabled', undefined)).not.toThrow();
  });
});

describe('LiveConfig stage-write gate', () => {
  let dir: string;
  let cfgPath: string;
  let live: LiveConfig;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-stage-'));
    cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ multiMachine: { sessionPool: { stage: 'dark' } } }, null, 2));
    live = new LiveConfig(dir); // ctor takes stateDir and appends config.json
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/stageWriteGuard.test.ts' }));

  it('REFUSES a direct stage write (no token) — the rollout stage cannot be flipped ad-hoc', () => {
    expect(() => live.set(STAGE_CONFIG_PATH, 'live-transfer')).toThrow(/not permitted/);
    // Unchanged on disk.
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).multiMachine.sessionPool.stage).toBe('dark');
  });

  it('ALLOWS the stage write when StageAdvancer passes the token', () => {
    live.set(STAGE_CONFIG_PATH, 'shadow', { stageWriteToken: STAGE_WRITE_TOKEN });
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).multiMachine.sessionPool.stage).toBe('shadow');
  });

  it('does NOT gate other config writes', () => {
    expect(() => live.set('multiMachine.sessionPool.enabled', true)).not.toThrow();
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).multiMachine.sessionPool.enabled).toBe(true);
  });
});
