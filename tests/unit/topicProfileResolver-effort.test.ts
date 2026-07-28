/**
 * Unit tests — the Topic Profile `effort` resolution arm in
 * TopicProfileResolver.resolve(): a valid pin resolves; an INVALID stored
 * value FAILS OPEN to undefined (no --effort) without throwing; an absent pin
 * resolves to undefined; and the config-default layer is honored / clamped.
 *
 * `effort` is a DIRECT Claude `--effort` pin (low|medium|high|xhigh|max),
 * distinct from the cross-framework `thinkingMode` abstraction. The fail-open
 * guarantee is the safety property under test: a poisoned on-disk value (e.g.
 * a legacy 'ultracode' pin) must never reach the CLI as a launch arg.
 *
 * These assertions FAIL against the pre-change resolver, which had no `effort`
 * field on ResolvedTopicProfile at all.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-resolver-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/topicProfileResolver-effort.test.ts cleanup' });
});

/**
 * Seed topic-profiles.json directly (bypassing the enum-clamping write
 * surface) so a deliberately-INVALID `effort` value can be persisted, then
 * build a store that loads it. This is how a poisoned on-disk value reaches
 * the resolver in production (a legacy pin, a hand-edited file, an enum that
 * shrank after the write).
 */
function storeWithRawEffort(rawEffort: unknown): TopicProfileStore {
  const stateFilePath = path.join(tmpDir, 'state', 'topic-profiles.json');
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(
    stateFilePath,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      topics: {
        '13481': {
          current: {
            effort: rawEffort,
            updatedAt: new Date().toISOString(),
            updatedBy: 'telegram:777',
          },
          previous: null,
          intendedProfile: null,
          parked: null,
          breakerCount: 0,
        },
      },
    }),
    'utf-8',
  );
  return new TopicProfileStore({ stateFilePath });
}

function resolverFor(
  store: TopicProfileStore,
  configDefaults: Record<string, { effort?: string }> = {},
): TopicProfileResolver {
  return new TopicProfileResolver({
    store,
    defaultFramework: () => 'claude-code',
    configTopicFrameworks: () => ({}),
    configProfileDefaults: () => configDefaults,
    frameworkDefaultModels: () => ({}),
    tierEscalationConfig: () => undefined,
    localModelBinding: () => null,
    frameworkBinaryPath: () => null,
  });
}

describe('TopicProfileResolver — effort arm', () => {
  it('resolves a valid stored effort pin', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const store = storeWithRawEffort(level);
      const resolved = resolverFor(store).resolve('13481');
      expect(resolved.effort).toBe(level);
      expect(resolved.sources.effort).toBe('profile-pin');
    }
  });

  it('FAILS OPEN to undefined on an invalid stored value — never throws, no --effort', () => {
    for (const bad of ['ultracode', 'ultra', 'xxhigh', 'HIGH', '', 'minimal']) {
      const store = storeWithRawEffort(bad);
      const resolver = resolverFor(store);
      // Must not throw on a poisoned value.
      const resolved = resolver.resolve('13481');
      expect(resolved.effort).toBeUndefined();
      expect(resolved.sources.effort).toBe('unset');
    }
  });

  it('resolves to undefined when no pin and no config default', () => {
    const stateFilePath = path.join(tmpDir, 'state', 'topic-profiles.json');
    const store = new TopicProfileStore({ stateFilePath });
    const resolved = resolverFor(store).resolve('99999');
    expect(resolved.effort).toBeUndefined();
    expect(resolved.sources.effort).toBe('unset');
  });

  it('honors a valid topicProfiles config default when no pin is set', () => {
    const stateFilePath = path.join(tmpDir, 'state', 'topic-profiles.json');
    const store = new TopicProfileStore({ stateFilePath });
    const resolved = resolverFor(store, { '13481': { effort: 'high' } }).resolve('13481');
    expect(resolved.effort).toBe('high');
    expect(resolved.sources.effort).toBe('topicProfiles-config-default');
  });

  it('a pin WINS over the config default', () => {
    const store = storeWithRawEffort('max');
    const resolved = resolverFor(store, { '13481': { effort: 'low' } }).resolve('13481');
    expect(resolved.effort).toBe('max');
    expect(resolved.sources.effort).toBe('profile-pin');
  });

  it('an invalid config default is ignored (fail open to undefined)', () => {
    const stateFilePath = path.join(tmpDir, 'state', 'topic-profiles.json');
    const store = new TopicProfileStore({ stateFilePath });
    const resolved = resolverFor(store, { '13481': { effort: 'ultracode' } }).resolve('13481');
    expect(resolved.effort).toBeUndefined();
    expect(resolved.sources.effort).toBe('unset');
  });
});
