/**
 * Unit tests — TopicProfileStore (TOPIC-PROFILE-SPEC §5.1 / §11).
 *
 * Covers: mutate field-merge + per-topic-lock serialization + atomicity;
 * the §4 model/modelTier hard mutual-exclusion refusal; durability-precedes-
 * acknowledgment (flush failure REFUSES + rolls back, including the
 * coalesced multi-waiter arm); the one-directional legacy seed (legacy never
 * overwrites a profile); the durable { current, previous } undo snapshot
 * (burst cadence — previous shifts once per disclosed burst); REPLACE
 * semantics (wholesale, no-delta REPLACE does NOT shift previous — the
 * round-trip-undo arm); the §14 dry-run shadow lifecycle incl. skew arms;
 * §10.4 parked-pin supersession by a new operator pin.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TopicProfileStore,
  FlushRefusedError,
  ProfileValidationRefusal,
  profilesEqual,
  type TopicProfile,
} from '../../src/core/TopicProfileStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let stateFile: string;
let legacyFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-profile-store-'));
  stateFile = path.join(tmpDir, 'state', 'topic-profiles.json');
  legacyFile = path.join(tmpDir, 'state', 'topic-frameworks.json');
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/TopicProfileStore.test.ts:afterEach',
  });
});

function newStore(opts: { isDryRun?: () => boolean } = {}): TopicProfileStore {
  return new TopicProfileStore({
    stateFilePath: stateFile,
    legacyFrameworksPath: legacyFile,
    isDryRun: opts.isDryRun,
  });
}

describe('TopicProfileStore — mutate field-merge', () => {
  it('merges only supplied fields, leaving sibling axes untouched', async () => {
    const store = newStore();
    await store.mutate(100, { framework: 'codex-cli', updatedBy: 'op:1' });
    await store.mutate(100, { thinkingMode: 'high', updatedBy: 'op:1' });

    const profile = store.resolve(100);
    expect(profile?.framework).toBe('codex-cli');
    expect(profile?.thinkingMode).toBe('high');
  });

  it('null clears a field; undefined leaves it', async () => {
    const store = newStore();
    await store.mutate(1, { model: 'opus', thinkingMode: 'low', updatedBy: 'op:1' });
    await store.mutate(1, { model: null, updatedBy: 'op:1' });

    const profile = store.resolve(1);
    expect(profile?.model).toBeNull();
    expect(profile?.thinkingMode).toBe('low');
  });

  it('reports changed:false for a no-op patch (no flush-side effects)', async () => {
    const store = newStore();
    await store.mutate(1, { model: 'opus', updatedBy: 'op:1' });
    const result = await store.mutate(1, { model: 'opus', updatedBy: 'op:1' });
    expect(result.changed).toBe(false);
  });

  it('§4 — HARD-refuses a merge result holding both model and modelTier', async () => {
    const store = newStore();
    await store.mutate(1, { modelTier: 'escalated', updatedBy: 'op:1' });
    await expect(
      store.mutate(1, { model: 'opus', updatedBy: 'op:1' }),
    ).rejects.toBeInstanceOf(ProfileValidationRefusal);
    // The profile is UNCHANGED (refusal, not silent winner).
    expect(store.resolve(1)?.modelTier).toBe('escalated');
    expect(store.resolve(1)?.model ?? null).toBeNull();
  });

  it('persists durably — survives a reload into a fresh store', async () => {
    const store = newStore();
    await store.mutate(7, { framework: 'codex-cli', thinkingMode: 'max', updatedBy: 'op:9' });

    const reloaded = newStore();
    const profile = reloaded.resolve(7);
    expect(profile?.framework).toBe('codex-cli');
    expect(profile?.thinkingMode).toBe('max');
    expect(profile?.updatedBy).toBe('op:9');
  });

  it('two concurrent different-topic mutates both survive a reload (§5.1 flush-queue snapshot)', async () => {
    const store = newStore();
    await Promise.all([
      store.mutate(1, { framework: 'codex-cli', updatedBy: 'op:1' }),
      store.mutate(2, { thinkingMode: 'high', updatedBy: 'op:1' }),
    ]);
    const reloaded = newStore();
    expect(reloaded.resolve(1)?.framework).toBe('codex-cli');
    expect(reloaded.resolve(2)?.thinkingMode).toBe('high');
  });

  it('serializes same-topic mutates through the per-topic lock', async () => {
    const store = newStore();
    const order: number[] = [];
    await Promise.all([
      store.withTopicLock(5, async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push(1);
      }),
      store.withTopicLock(5, async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});

describe('TopicProfileStore — durability precedes acknowledgment (§5.1)', () => {
  it('a failed flush REFUSES the write and rolls back the cache', async () => {
    const store = newStore();
    await store.mutate(1, { model: 'opus', updatedBy: 'op:1' });

    // Make the state dir unwritable so the next flush fails.
    const stateDir = path.dirname(stateFile);
    fs.chmodSync(stateDir, 0o500);
    try {
      await expect(
        store.mutate(1, { model: 'sonnet', updatedBy: 'op:1' }),
      ).rejects.toBeInstanceOf(FlushRefusedError);
      // Rollback: the refused pin is ABSENT from resolution.
      expect(store.resolve(1)?.model).toBe('opus');
    } finally {
      fs.chmodSync(stateDir, 0o700);
    }

    // The refused pin is absent from the NEXT successful flush too.
    await store.mutate(2, { thinkingMode: 'low', updatedBy: 'op:1' });
    const reloaded = newStore();
    expect(reloaded.resolve(1)?.model).toBe('opus');
  });

  it('coalesced multi-waiter failure refuses and rolls back every undurable write together', async () => {
    const store = newStore();
    await store.mutate(1, { model: 'opus', updatedBy: 'op:1' });

    const stateDir = path.dirname(stateFile);
    fs.chmodSync(stateDir, 0o500);
    try {
      const results = await Promise.allSettled([
        store.mutate(1, { model: 'sonnet', updatedBy: 'op:1' }),
        store.mutate(2, { thinkingMode: 'high', updatedBy: 'op:1' }),
        store.mutate(3, { framework: 'codex-cli', updatedBy: 'op:1' }),
      ]);
      for (const r of results) {
        expect(r.status).toBe('rejected');
      }
      expect(store.resolve(1)?.model).toBe('opus');
      expect(store.resolve(2)).toBeNull();
      expect(store.resolve(3)).toBeNull();
    } finally {
      fs.chmodSync(stateDir, 0o700);
    }
  });
});

describe('TopicProfileStore — legacy seed (one-directional, §5.1)', () => {
  it('seeds framework for topics absent from the profile store', () => {
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ updatedAt: new Date().toISOString(), topics: { '42': 'codex-cli' } }),
    );
    const store = newStore();
    expect(store.resolve(42)?.framework).toBe('codex-cli');
    expect(store.resolve(42)?.updatedBy).toBe('system:legacy-seed');
    // previous is null — undo with no snapshot is refused upstream.
    expect(store.previousFor(42)).toBeNull();
  });

  it('NEVER overwrites an existing profile entry from a STALE legacy file (crash-window shape)', async () => {
    const store = newStore();
    await store.mutate(42, { framework: 'claude-code', updatedBy: 'op:1' });

    // Legacy updatedAt OLDER than the profile entry: the §12 crash-window /
    // stale-mirror shape — the profile store is newer and must win.
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ updatedAt: new Date(Date.now() - 60_000).toISOString(), topics: { '42': 'codex-cli' } }),
    );
    const reloaded = newStore();
    expect(reloaded.resolve(42)?.framework).toBe('claude-code');
  });

  it('rollback-window reconcile: an externally-written NEWER legacy value re-seeds the framework arm (§12 roll-forward-after-rollback)', async () => {
    const store = newStore();
    await store.mutate(42, { framework: 'claude-code', model: 'claude-opus-4-8', updatedBy: 'op:1' });
    // Allow the post-flush mirror write to land (stamps mirrorGeneratedAt).
    await new Promise((r) => setTimeout(r, 20));

    // A rolled-back binary's live /route write: external (updatedAt ≠ mirror
    // stamp), NEWER than the profile entry, with a differing framework VALUE.
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ updatedAt: new Date(Date.now() + 60_000).toISOString(), topics: { '42': 'codex-cli' } }),
    );
    const reloaded = newStore();
    const current = reloaded.resolve(42);
    expect(current?.framework).toBe('codex-cli');
    // Framework arm ONLY — the model pin survives the reconcile.
    expect(current?.model).toBe('claude-opus-4-8');
    expect(current?.updatedBy).toBe('system:rollback-window-reconcile');
  });

  it('retains a migration-time snapshot of the legacy file as the rollback artifact', () => {
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ updatedAt: new Date().toISOString(), topics: { '42': 'codex-cli' } }),
    );
    newStore();
    expect(fs.existsSync(`${legacyFile}.pre-profile-seed`)).toBe(true);
  });

  it('regenerates the legacy mirror from the profile store on framework writes', async () => {
    const store = newStore();
    await store.mutate(9, { framework: 'codex-cli', updatedBy: 'op:1' });
    // Allow the post-flush mirror write to land.
    await new Promise((r) => setTimeout(r, 20));
    const mirror = JSON.parse(fs.readFileSync(legacyFile, 'utf-8')) as { topics: Record<string, string> };
    expect(mirror.topics['9']).toBe('codex-cli');
  });
});

describe('TopicProfileStore — undo snapshot ({ current, previous }, §5.1/§8)', () => {
  it('previous shifts when the orchestration signals the first write of a burst', async () => {
    const store = newStore();
    await store.mutate(1, { model: 'opus', updatedBy: 'op:1', }, { shiftPrevious: true });
    // Burst: two writes in one window — only the FIRST shifts previous.
    await store.mutate(1, { model: 'sonnet', updatedBy: 'op:1' }, { shiftPrevious: true });
    await store.mutate(1, { model: 'haiku', updatedBy: 'op:1' }, { shiftPrevious: false });

    // Undo restores the PRE-burst profile (model: 'opus'), not the intermediate.
    expect(store.previousFor(1)?.model).toBe('opus');
  });

  it('the undo target survives restarts (durable in the same file)', async () => {
    const store = newStore();
    await store.mutate(1, { model: 'opus', updatedBy: 'op:1' }, { shiftPrevious: true });
    await store.mutate(1, { model: 'sonnet', updatedBy: 'op:1' }, { shiftPrevious: true });

    const reloaded = newStore();
    expect(reloaded.previousFor(1)?.model).toBe('opus');
  });
});

describe('TopicProfileStore — REPLACE (transfer/restore-apply, §5.3)', () => {
  const profile = (over: Partial<TopicProfile>): TopicProfile => ({
    updatedAt: new Date().toISOString(),
    updatedBy: 'op:peer',
    ...over,
  });

  it('is a wholesale per-topic REPLACE, not a field-merge', async () => {
    const store = newStore();
    await store.mutate(1, { model: 'opus', thinkingMode: 'high', updatedBy: 'op:1' });
    // Arriving entry has NO thinkingMode — a merge would resurrect it.
    await store.replaceEntry(1, { current: profile({ framework: 'codex-cli' }) });
    const resolved = store.resolve(1);
    expect(resolved?.framework).toBe('codex-cli');
    expect(resolved?.thinkingMode ?? null).toBeNull();
    expect(resolved?.model ?? null).toBeNull();
  });

  it('pins previous to the receiving machine\'s pre-replace current', async () => {
    const store = newStore();
    await store.mutate(1, { model: 'opus', updatedBy: 'op:1' });
    await store.replaceEntry(1, { current: profile({ model: 'sonnet' }) });
    expect(store.previousFor(1)?.model).toBe('opus');
  });

  it('round-trip-undo arm: a no-delta REPLACE does NOT shift previous (§5.1 round-10)', async () => {
    const store = newStore();
    // Pre-pin state, then a pin that shifts previous.
    await store.mutate(1, { model: 'opus', updatedBy: 'op:1' }, { shiftPrevious: true });
    await store.mutate(1, { model: 'sonnet', updatedBy: 'op:1' }, { shiftPrevious: true });
    expect(store.previousFor(1)?.model).toBe('opus');

    // Transfer A→B→A with no changes: the arriving entry equals local current.
    const current = store.resolve(1)!;
    const result = await store.replaceEntry(1, { current: { ...current } });
    expect(result.delta).toBe(false);
    // Undo still restores the pre-pin profile.
    expect(store.previousFor(1)?.model).toBe('opus');
  });
});

describe('TopicProfileStore — REPLACE receiving-machine revalidation (§5.3/§10.2)', () => {
  const arriving = (over: Partial<TopicProfile>): TopicProfile => ({
    updatedAt: '2026-06-01T00:00:00.000Z',
    updatedBy: 'op:peer',
    ...over,
  });
  const revalidate = { revalidate: { fallbackFramework: 'claude-code' as const } };

  it('drops an off-enum field to null and keeps valid siblings, reporting droppedFields', async () => {
    const store = newStore();
    const result = await store.replaceEntry(
      1,
      { current: arriving({ framework: 'codex-cli', thinkingMode: 'turbo' as never }) },
      revalidate,
    );
    expect(store.resolve(1)?.framework).toBe('codex-cli');
    expect(store.resolve(1)?.thinkingMode ?? null).toBeNull();
    expect(result.droppedFields).toHaveLength(1);
    expect(result.droppedFields[0]).toMatchObject({ field: 'thinkingMode', failure: 'off-enum' });
  });

  it('validates the arriving model against the ARRIVING framework (framework-compat)', async () => {
    const store = newStore();
    // 'opus' is a claude id — invalid on the arriving codex framework.
    const bad = await store.replaceEntry(
      1,
      { current: arriving({ framework: 'codex-cli', model: 'opus' }) },
      revalidate,
    );
    expect(store.resolve(1)?.model ?? null).toBeNull();
    expect(bad.droppedFields.some((d) => d.field === 'model')).toBe(true);

    // A codex id on the codex framework is kept.
    const ok = await store.replaceEntry(
      2,
      { current: arriving({ framework: 'codex-cli', model: 'gpt-5.4' }) },
      revalidate,
    );
    expect(ok.droppedFields).toHaveLength(0);
    expect(store.resolve(2)?.model).toBe('gpt-5.4');
  });

  it('falls back to the receiving default framework for the model arm when the arriving framework is invalid', async () => {
    const store = newStore();
    // Framework off-enum (dropped); 'opus' then validates against the
    // fallback (claude-code) and is KEPT.
    const result = await store.replaceEntry(
      1,
      { current: arriving({ framework: 'vim' as never, model: 'opus' }) },
      revalidate,
    );
    expect(store.resolve(1)?.framework ?? null).toBeNull();
    expect(store.resolve(1)?.model).toBe('opus');
    expect(result.droppedFields.some((d) => d.field === 'framework')).toBe(true);
  });

  it('§4 hard mutual exclusion: an arriving entry holding BOTH model and modelTier drops both', async () => {
    const store = newStore();
    const result = await store.replaceEntry(
      1,
      { current: arriving({ model: 'opus', modelTier: 'escalated' }) },
      revalidate,
    );
    expect(store.resolve(1)?.model ?? null).toBeNull();
    expect(store.resolve(1)?.modelTier ?? null).toBeNull();
    expect(result.droppedFields.some((d) => d.failure === 'model-and-tier-both-set')).toBe(true);
  });

  it('malformed provenance means the arriving entry is treated as ABSENT (never persisted)', async () => {
    const store = newStore();
    await store.mutate(1, { framework: 'gemini-cli', updatedBy: 'op:local' });
    const result = await store.replaceEntry(
      1,
      { current: { framework: 'codex-cli' } as never },
      revalidate,
    );
    // Treated as current:null — the malformed payload itself never lands.
    expect(result.droppedFields.some((d) => d.failure === 'unknown-field')).toBe(true);
    expect(store.resolve(1)?.framework ?? null).not.toBe('codex-cli');
  });

  it('revalidates the arriving dry-run shadow the same way (§5.3 — shadow travels, clamped)', async () => {
    const store = newStore({ isDryRun: () => true });
    const result = await store.replaceEntry(
      1,
      {
        current: null,
        intendedProfile: {
          fields: { thinkingMode: 'max', escalationOverride: 'sometimes' as never },
          recordedAt: '2026-06-01T00:00:00.000Z',
          recordedBy: 'op:peer',
        },
      },
      revalidate,
    );
    expect(store.get(1)?.intendedProfile?.fields.thinkingMode).toBe('max');
    expect(store.get(1)?.intendedProfile?.fields.escalationOverride ?? null).toBeNull();
    expect(result.droppedFields.some((d) => d.field === 'escalationOverride')).toBe(true);
  });

  it('without the revalidate option the REPLACE stays verbatim (trusted local callers)', async () => {
    const store = newStore();
    await store.replaceEntry(1, { current: arriving({ thinkingMode: 'turbo' as never }) });
    expect(store.resolve(1)?.thinkingMode).toBe('turbo');
  });
});

describe('TopicProfileStore — dry-run shadow lifecycle (§14)', () => {
  it('the shadow is never read by resolution', async () => {
    const store = newStore({ isDryRun: () => true });
    await store.setShadow(1, { framework: 'codex-cli' }, 'op:1');
    expect(store.resolve(1)).toBeNull();
    expect(store.get(1)?.intendedProfile?.fields.framework).toBe('codex-cli');
  });

  it('clearAllShadows clears every topic and returns the expired intents (flip-clear)', async () => {
    const store = newStore({ isDryRun: () => true });
    await store.setShadow(1, { framework: 'codex-cli' }, 'op:1');
    await store.setShadow(2, { thinkingMode: 'max' }, 'op:1');

    const cleared = await store.clearAllShadows();
    expect(cleared).toHaveLength(2);
    expect(store.get(1)?.intendedProfile).toBeNull();
    expect(store.get(2)?.intendedProfile).toBeNull();
    // Never promoted.
    expect(store.resolve(1)).toBeNull();
  });

  it('an accepted LIVE write clears that topic\'s stale shadow (supersession)', async () => {
    const store = newStore({ isDryRun: () => true });
    await store.setShadow(1, { framework: 'codex-cli' }, 'op:1');
    await store.mutate(1, { thinkingMode: 'low', updatedBy: 'op:1' });
    expect(store.get(1)?.intendedProfile).toBeNull();
  });

  it('skew arm (i): a non-dry-run receiver discards an arriving shadow', async () => {
    const store = newStore({ isDryRun: () => false });
    const result = await store.replaceEntry(1, {
      current: null,
      intendedProfile: { fields: { framework: 'codex-cli' }, recordedAt: 'x', recordedBy: 'op' },
    });
    expect(result.discardedArrivingShadow).toBe(true);
    expect(store.get(1)?.intendedProfile).toBeNull();
  });

  it('skew arm (ii): a shadowless arriving entry never destroys a populated local shadow on a dry-run receiver', async () => {
    const store = newStore({ isDryRun: () => true });
    await store.setShadow(1, { thinkingMode: 'max' }, 'op:1');
    const result = await store.replaceEntry(1, {
      current: { framework: 'claude-code', updatedAt: 'x', updatedBy: 'op:peer' },
    });
    expect(result.retainedLocalShadow).toBe(true);
    expect(store.get(1)?.intendedProfile?.fields.thinkingMode).toBe('max');
  });

  it('shadow-only no-live-delta REPLACE reports delta:false and does not shift previous (R14-2 fixture)', async () => {
    const store = newStore({ isDryRun: () => true });
    await store.mutate(1, { model: 'opus', updatedBy: 'op:1' }, { shiftPrevious: true });
    const current = store.resolve(1)!;
    const result = await store.replaceEntry(1, {
      current: { ...current },
      intendedProfile: { fields: { thinkingMode: 'max' }, recordedAt: 'x', recordedBy: 'op' },
    });
    expect(result.delta).toBe(false);
    // The shadow fate is still a disclosure-worthy event — the caller reads
    // discarded/retained flags; here the dry-run receiver applied it.
    expect(store.get(1)?.intendedProfile?.fields.thinkingMode).toBe('max');
  });
});

describe('TopicProfileStore — §10.4 parked pins + breaker counter', () => {
  it('parkAndRevert retains the failing profile as intended-but-unhealthy', async () => {
    const store = newStore();
    await store.mutate(1, { framework: 'codex-cli', updatedBy: 'op:1' });
    await store.parkAndRevert(1, 'spawn-failure-breaker', {
      framework: 'claude-code',
      updatedAt: 'x',
      updatedBy: 'op:1',
    });
    expect(store.resolve(1)?.framework).toBe('claude-code');
    expect(store.resolve(1)?.updatedBy).toBe('system:circuit-breaker');
    expect(store.parkedFor(1)?.profile.framework).toBe('codex-cli');
  });

  it('a new deliberate operator pin atomically supersedes the parked state + breaker counter', async () => {
    const store = newStore();
    await store.mutate(1, { framework: 'codex-cli', updatedBy: 'op:1' });
    await store.incrementBreaker(1);
    await store.parkAndRevert(1, 'spawn-failure-breaker', null);

    const result = await store.mutate(1, { thinkingMode: 'high', updatedBy: 'op:1' });
    expect(result.supersededParked).toBe(true);
    expect(store.parkedFor(1)).toBeNull();
    expect(store.get(1)?.breakerCount).toBe(0);
  });

  it('system writes do NOT supersede a parked pin (§5.3 — breaker can\'t shed operator intent)', async () => {
    const store = newStore();
    await store.mutate(1, { framework: 'codex-cli', updatedBy: 'op:1' });
    await store.parkAndRevert(1, 'breaker', null);
    await store.mutate(1, { framework: 'claude-code', updatedBy: 'system:spawn-fallback' });
    expect(store.parkedFor(1)?.profile.framework).toBe('codex-cli');
  });

  it('breaker counter increments and resets on success', async () => {
    const store = newStore();
    expect(await store.incrementBreaker(1)).toBe(1);
    expect(await store.incrementBreaker(1)).toBe(2);
    await store.resetBreaker(1);
    expect(store.get(1)?.breakerCount).toBe(0);
  });
});

describe('profilesEqual', () => {
  it('treats absent and null fields as equal', () => {
    expect(
      profilesEqual(
        { updatedAt: 'a', updatedBy: 'x', model: null },
        { updatedAt: 'b', updatedBy: 'y' },
      ),
    ).toBe(true);
  });

  it('detects axis differences', () => {
    expect(
      profilesEqual(
        { updatedAt: 'a', updatedBy: 'x', thinkingMode: 'low' },
        { updatedAt: 'a', updatedBy: 'x', thinkingMode: 'high' },
      ),
    ).toBe(false);
  });
});

describe('TopicProfileStore — corrupt state tolerance', () => {
  it('boots with an empty store on a corrupt file (never throws)', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{nope');
    const store = newStore();
    expect(store.resolve(1)).toBeNull();
  });
});
