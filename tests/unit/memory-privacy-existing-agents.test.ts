/**
 * Justin, 2026-11-04: an update must never restrict an existing agent. Covers the
 * migration, the first boot before it reaches memory, new agents, and bounded sessions
 * that survive a restart. Spec: docs/specs/memory-privacy.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wireMemoryPrivacy } from '../../src/users/wireMemoryPrivacy.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('memory privacy on existing agents', () => {
  let dir: string;
  let stateDir: string;
  let wiring: { privacy: { enabled: boolean } } | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-existing-'));
    stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([
      { id: 'owner', name: 'o', channels: [], permissions: ['admin'], preferences: {}, slackUserId: 'U1' },
      { id: 'other', name: 'p', channels: [], permissions: [], preferences: {}, slackUserId: 'U2' },
    ]));
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/memory-privacy-existing-agents.test.ts' }));

  const wire = (memoryPrivacy: Record<string, unknown> | undefined, probe = false) => wireMemoryPrivacy({
    projectDir: dir, stateDir, projectName: 'old', instarRoot: dir, framework: () => 'claude-code',
    memoryPrivacy: () => memoryPrivacy as never,
    messaging: () => [{ type: 'slack', config: { authorizedUserIds: ['U1', 'U2'] } }],
    probe: async () => probe, slackBotUserId: () => 'B',
    sessionManager: { setMemoryPrivacy: () => {}, retireSessionsForAudienceChange: async () => [], retireSessionUnlessAudience: async () => false } as never,
  });
  const migrate = (config: unknown) => {
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config));
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4321, hasTelegram: false, projectName: 'old' });
    const result: Result = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateConfig(r: Result): void }).migrateConfig(result);
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
  };

  it.each([
    ['unset, as on the first boot before the migration reaches memory', undefined],
    ['an empty block', {}],
    ['people named but no choice made', { sharedMemoryPeople: ['a', 'b'] }],
    ['an explicit false', { enabled: false }],
  ])('%s: off', (_name, config) => {
    expect(wire(config).privacy.enabled).toBe(false);
  });

  it('explicit true: on', () => {
    expect(wire({ enabled: true }).privacy.enabled).toBe(true);
  });

  it('upgraded multi-person agent in a group topic with no sandbox: delivered, never refused', async () => {
    const w = wire(undefined, false);
    await w.ready;
    expect(await w.tracker.onInbound({
      placeKey: 'telegram:-100123', placeKind: 'shared', senderKey: 'telegram:42', personId: null,
      readerCount: async () => 5, liveSession: () => 'topic-session',
    })).toBe('deliver');
    expect(w.privacy.isMultiPerson()).toBe(false);
  });

  it('same place on an opted-in agent with no sandbox still refuses: the check is the setting', async () => {
    const w = wire({ enabled: true }, false);
    await w.ready;
    expect(await w.tracker.onInbound({
      placeKey: 'telegram:-100123', placeKind: 'shared', senderKey: 'telegram:42', personId: null,
      readerCount: async () => 5,
    })).toBe('unavailable');
  });

  it('migration writes false where unset, once, and keeps the rest of the block', () => {
    expect(migrate({ port: 1 }).memoryPrivacy).toEqual({ enabled: false });
    const people = migrate({ memoryPrivacy: { sharedMemoryPeople: ['justin', 'adri'] } }).memoryPrivacy;
    expect(people).toEqual({ sharedMemoryPeople: ['justin', 'adri'], enabled: false });
  });

  it('migration leaves the choice of an owner alone', () => {
    expect(migrate({ memoryPrivacy: { enabled: true } }).memoryPrivacy.enabled).toBe(true);
    expect(migrate({ memoryPrivacy: { enabled: false } }).memoryPrivacy.enabled).toBe(false);
  });

  it('no way of creating an agent turns it on, until failover keeps the setting', () => {
    for (const file of ['src/commands/init.ts', 'src/commands/setup.ts', '.claude/skills/setup-wizard/SKILL.md']) {
      expect(fs.readFileSync(path.join(process.cwd(), file), 'utf8')).not.toMatch(/memoryPrivacy/);
    }
  });

  it('with it off, boot probes nothing, so an update installs nothing and raises no alert', async () => {
    const probe = vi.fn(async () => false);
    const w = wireMemoryPrivacy({
      projectDir: dir, stateDir, projectName: 'old', instarRoot: dir, framework: () => 'claude-code',
      memoryPrivacy: () => undefined, messaging: () => [], probe,
      sessionManager: { setMemoryPrivacy: () => {} } as never,
    });
    await w.ready;
    expect(probe).not.toHaveBeenCalled();
  });

  it('opted in, boot still probes', async () => {
    const probe = vi.fn(async () => true);
    const w = wireMemoryPrivacy({
      projectDir: dir, stateDir, projectName: 'old', instarRoot: dir, framework: () => 'claude-code',
      memoryPrivacy: () => ({ enabled: true }), messaging: () => [], probe,
      sessionManager: { setMemoryPrivacy: () => {} } as never,
    });
    await w.ready;
    expect(probe).toHaveBeenCalled();
  });

  it('with it off, a session still inside the boundary is ended, and only that one', async () => {
    const retire = vi.fn(async () => true);
    const manager = {
      memoryPrivacyWiring: { privacy: { enabled: false } }, retireMemorySession: retire,
      listRunningSessions: () => [{ name: 'bounded', memoryScopeDir: '/s' }, { name: 'plain' }],
    };
    expect(await SessionManager.prototype.retireBoundedSessionsWhenPrivacyOff.call(manager as never)).toEqual(['bounded']);
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it('with it on, no session is ended by this step', async () => {
    const retire = vi.fn(async () => true);
    const manager = {
      memoryPrivacyWiring: { privacy: { enabled: true } }, retireMemorySession: retire,
      listRunningSessions: () => [{ name: 'bounded', memoryScopeDir: '/s' }],
    };
    expect(await SessionManager.prototype.retireBoundedSessionsWhenPrivacyOff.call(manager as never)).toEqual([]);
    expect(retire).not.toHaveBeenCalled();
  });
});
