import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persistDiskTopicSessionBinding, resolveSessionSpawnTopicBinding } from '../../src/server/sessionSpawnTopicBinding.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('session spawn topic binding', () => {
  let dir = '';

  afterEach(() => {
    if (dir) {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/session-spawn-topic-binding.test.ts:cleanup' });
      dir = '';
    }
  });

  it('refuses a lane spawn that does not carry a topic binding', () => {
    const r = resolveSessionSpawnTopicBinding({ name: 'worker', spawnRole: 'lane' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/topicId/i);
  });

  it('accepts and normalizes a topic-bound lane spawn', () => {
    const r = resolveSessionSpawnTopicBinding({
      name: 'worker',
      spawnRole: 'lane',
      topicId: '29723',
      topicName: '  Pathway  ',
    });
    expect(r).toEqual({ ok: true, binding: { required: true, topicId: 29723, topicName: 'Pathway' } });
  });

  it('refuses an invalid topic id instead of spawning unbound', () => {
    const r = resolveSessionSpawnTopicBinding({ name: 'worker-lane', topicId: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/positive integer/i);
  });

  it('treats lane-number spawn names as topic-required', () => {
    const r = resolveSessionSpawnTopicBinding({ name: 'w27-lane2-admission-delivery' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/topicId/i);
  });

  // Observer-2 finding 1: `_` is a JS word character, so the old `\b`-anchored
  // classifier missed every underscore-separated form. `/sessions/spawn` accepts
  // `[a-zA-Z0-9_-]`, so each name below is genuinely spawnable.
  it.each([
    'w27_lane2_admission_delivery',
    'worker_orchestrator',
    'pathway_17',
    'w27_lane_delivery',
    'orchestrator_w27',
  ])('treats underscore-separated lane/orchestrator/pathway name %s as topic-required', (name) => {
    const r = resolveSessionSpawnTopicBinding({ name });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/topicId/i);
  });

  it('still binds an underscore-form lane spawn when a topic IS supplied', () => {
    const r = resolveSessionSpawnTopicBinding({ name: 'w27_lane2_admission_delivery', topicId: 29723 });
    expect(r).toEqual({ ok: true, binding: { required: true, topicId: 29723, topicName: undefined } });
  });

  // Negative control: the underscore normalisation must not widen the matcher
  // into unrelated names that merely CONTAIN the substrings.
  it.each([
    'airplane_worker',
    'my_plane',
    'pathways_index',
    'release_worker',
  ])('does not require a topic for unrelated underscore name %s', (name) => {
    const r = resolveSessionSpawnTopicBinding({ name });
    expect(r).toEqual({ ok: true, binding: { required: false, topicId: undefined, topicName: undefined } });
  });

  it('persists the disk topic registry when TelegramAdapter is not wired', () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-topic-binding-')));
    const stateDir = path.join(dir, '.instar');
    persistDiskTopicSessionBinding({
      stateDir,
      topicId: 43003,
      tmuxSession: 'proj-orchestrator-worker',
      topicName: 'Observer 2',
    });
    const registry = JSON.parse(fs.readFileSync(path.join(stateDir, 'topic-session-registry.json'), 'utf-8'));
    expect(registry.topicToSession['43003']).toBe('proj-orchestrator-worker');
    expect(registry.topicToName['43003']).toBe('Observer 2');
  });
});
