/**
 * Unit tests — TopicProfileWriteSurface (TOPIC-PROFILE-SPEC §5.2 / §10 / §11).
 *
 * The regime decision tree with REAL store + resolver deps:
 *  - §5.2(d): framework-arm writes land LIVE under the shipped fleet config
 *    (enabled:false AND dryRun:true — pinned) and the legacy immediate respawn
 *    fires; no shadow, no [dry-run] prefix on the reply.
 *  - New axes: refused while disabled; shadowed under dryRun (with [dry-run]
 *    notice); live when fully-live.
 *  - Mixed delta split: framework live + thinking refused/shadowed, each arm's
 *    fate named.
 *  - §5.2(b): recovery writes (clear, re-apply) are LIVE in every regime;
 *    their application arm never kills outside fully-live (told out loud).
 *  - §10.3 undo: restores the previous snapshot; nothing-to-undo refused
 *    plainly; legacy-undo loss disclosure names the CONTINUATION loss.
 *  - §10.1: bound-operator refusal both sides; token-trust refuses unbound
 *    topics; updatedBy stamped server-side.
 *  - §10.4: re-apply cooldown requires confirm; parked supersession wording.
 *  - §10.2: validation refusals leave the profile unchanged, audited.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import {
  TopicProfileWriteSurface,
  type ProfileWriteRegime,
} from '../../src/core/topicProfileWriteSurface.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-profile-surface-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/topicProfileWriteSurface.test.ts:afterEach',
  });
});

const OPERATOR = { kind: 'operator' as const, platform: 'telegram', uid: '777' };

interface Harness {
  store: TopicProfileStore;
  surface: TopicProfileWriteSurface;
  respawns: string[];
  disclosures: Array<{ topic: string; text: string }>;
  audits: Record<string, unknown>[];
  regime: ProfileWriteRegime;
}

function harness(regime: ProfileWriteRegime, opts: {
  boundUid?: string | null;
  localBinding?: boolean;
  respawnFails?: boolean;
  reapplyCooldownMs?: number;
  now?: () => number;
} = {}): Harness {
  const store = new TopicProfileStore({
    stateFilePath: path.join(tmpDir, 'state', 'topic-profiles.json'),
    isDryRun: () => regime.dryRun,
  });
  const resolver = new TopicProfileResolver({
    store,
    defaultFramework: () => 'claude-code',
    configTopicFrameworks: () => ({}),
    configProfileDefaults: () => ({}),
    frameworkDefaultModels: () => ({}),
    tierEscalationConfig: () => undefined,
    localModelBinding: () => null,
    frameworkBinaryPath: () => null, // launchability fails toward launchable
  });
  const respawns: string[] = [];
  const disclosures: Array<{ topic: string; text: string }> = [];
  const audits: Record<string, unknown>[] = [];
  let seq = 0;
  const surface = new TopicProfileWriteSurface({
    store,
    resolver,
    regime: () => regime,
    boundOperator: () =>
      opts.boundUid === null ? null : { platform: 'telegram', uid: opts.boundUid ?? '777' },
    localModelBinding: () => (opts.localBinding ? { provider: 'ollama' } : null),
    legacyFrameworkRespawn: async (topicKey) => {
      respawns.push(topicKey);
      return opts.respawnFails ? { respawned: false, error: 'tmux broke' } : { respawned: true };
    },
    orchestrator: null,
    disclose: async (topic, text) => { disclosures.push({ topic, text }); },
    audit: (event) => { audits.push(event); return `seq-${++seq}`; },
    reapplyCooldownMs: opts.reapplyCooldownMs,
    now: opts.now,
  });
  return { store, surface, respawns, disclosures, audits, regime };
}

// The SHIPPED FLEET default config — pinned so these tests cannot pass under a
// non-shipped combination (§11 back-compat arm).
const FLEET_REGIME: ProfileWriteRegime = { enabled: false, dryRun: true };
// The SHIPPED DEV-AGENT config (§11 shadow-regime arm).
const DEV_REGIME: ProfileWriteRegime = { enabled: true, dryRun: true };
const FULLY_LIVE: ProfileWriteRegime = { enabled: true, dryRun: false };

describe('§5.2(d) — framework writes are exempt from BOTH knobs', () => {
  it('lands LIVE in the store + legacy immediate respawn under enabled:false AND dryRun:true', async () => {
    const h = harness(FLEET_REGIME);
    const result = await h.surface.applyWrite({
      topicKey: 23, patch: { framework: 'codex-cli' }, principal: OPERATOR, origin: 'slash-route',
      discloseInReply: true,
    });
    expect(result.ok).toBe(true);
    expect(result.appliedLive).toContain('framework');
    expect(result.shadowed).toEqual([]);
    expect(result.legacyRespawned).toBe(true);
    expect(h.respawns).toEqual(['23']);
    // LIVE in the store, not in the dry-run shadow
    expect(h.store.resolve(23)?.framework).toBe('codex-cli');
    expect(h.store.get(23)?.intendedProfile).toBeNull();
    // no [dry-run] prefix on the user-facing reply
    expect(result.reply).not.toContain('[dry-run]');
    // disclosure-of-record carries the audit stamp
    expect(result.reply).toContain('seq-');
  });

  it('same under the dev-agent shipped config (enabled:true AND dryRun:true)', async () => {
    const h = harness(DEV_REGIME);
    const result = await h.surface.applyWrite({
      topicKey: 23, patch: { framework: 'codex-cli' }, principal: OPERATOR, origin: 'conversational',
      discloseInReply: true,
    });
    expect(result.ok).toBe(true);
    expect(h.store.resolve(23)?.framework).toBe('codex-cli');
    expect(h.respawns).toEqual(['23']);
    expect(result.reply).not.toContain('[dry-run]');
  });

  it('survives a failed respawn with the write persisted + honest reply', async () => {
    const h = harness(FLEET_REGIME, { respawnFails: true });
    const result = await h.surface.applyWrite({
      topicKey: 23, patch: { framework: 'codex-cli' }, principal: OPERATOR, origin: 'slash-route',
      discloseInReply: true,
    });
    expect(result.ok).toBe(true);
    expect(result.legacyRespawned).toBe(false);
    expect(h.store.resolve(23)?.framework).toBe('codex-cli');
    expect(result.reply).toContain('respawn failed');
  });
});

describe('new axes — gated by enabled + dryRun', () => {
  it('refuses a new-axis pin while disabled (the profile is unchanged)', async () => {
    const h = harness(FLEET_REGIME);
    const result = await h.surface.applyWrite({
      topicKey: 23, patch: { thinkingMode: 'high' }, principal: OPERATOR, origin: 'conversational',
    });
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe('disabled');
    expect(h.store.resolve(23)).toBeNull();
    expect(h.audits.some(a => a.outcome === 'refused' && a.reason === 'disabled')).toBe(true);
  });

  it('shadows a new-axis pin under dryRun (resolution never reads it)', async () => {
    const h = harness(DEV_REGIME);
    const result = await h.surface.applyWrite({
      topicKey: 23, patch: { thinkingMode: 'high' }, principal: OPERATOR, origin: 'conversational',
      discloseInReply: true,
    });
    expect(result.ok).toBe(true);
    expect(result.shadowed).toEqual(['thinkingMode']);
    expect(result.appliedLive).toEqual([]);
    expect(result.reply).toContain('[dry-run]');
    expect(h.store.resolve(23)).toBeNull(); // live profile untouched
    expect(h.store.get(23)?.intendedProfile?.fields.thinkingMode).toBe('high');
  });

  it('applies a new-axis pin LIVE when fully-live, told-out-loud apply-at-next-spawn (no orchestrator yet)', async () => {
    const h = harness(FULLY_LIVE);
    const result = await h.surface.applyWrite({
      topicKey: 23, patch: { thinkingMode: 'high' }, principal: OPERATOR, origin: 'conversational',
      discloseInReply: true,
    });
    expect(result.ok).toBe(true);
    expect(result.appliedLive).toEqual(['thinkingMode']);
    expect(h.store.resolve(23)?.thinkingMode).toBe('high');
    expect(result.reply).toContain('next session restart');
    expect(h.respawns).toEqual([]); // a thinking pin never rides the legacy kill
  });

  it('mixed delta SPLITS: framework live, thinking refused — each arm named (fleet config)', async () => {
    const h = harness(FLEET_REGIME);
    const result = await h.surface.applyWrite({
      topicKey: 23,
      patch: { framework: 'codex-cli', thinkingMode: 'high' },
      principal: OPERATOR, origin: 'conversational', discloseInReply: true,
    });
    expect(result.ok).toBe(true);
    expect(result.appliedLive).toEqual(['framework']);
    expect(result.refusedFields).toEqual(['thinkingMode']);
    expect(h.store.resolve(23)?.framework).toBe('codex-cli');
    expect(h.store.resolve(23)?.thinkingMode).toBeUndefined();
    expect(result.reply).toContain("isn't enabled");
    expect(h.respawns).toEqual(['23']);
  });

  it('mixed delta SPLITS: framework live, thinking shadowed (dev config)', async () => {
    const h = harness(DEV_REGIME);
    const result = await h.surface.applyWrite({
      topicKey: 23,
      patch: { framework: 'codex-cli', thinkingMode: 'high' },
      principal: OPERATOR, origin: 'conversational', discloseInReply: true,
    });
    expect(result.ok).toBe(true);
    expect(result.appliedLive).toEqual(['framework']);
    expect(result.shadowed).toEqual(['thinkingMode']);
    expect(h.store.get(23)?.intendedProfile?.fields.thinkingMode).toBe('high');
  });
});

describe('§5.2(b) — recovery writes LIVE in every regime, application regime-governed', () => {
  it('CLEAR of a live pin under dryRun:true is a LIVE write, no kill, told out loud', async () => {
    const h = harness(DEV_REGIME);
    // seed a live framework pin through the exempted arm
    await h.surface.applyWrite({
      topicKey: 23, patch: { framework: 'codex-cli' }, principal: OPERATOR, origin: 'slash-route', discloseInReply: true,
    });
    h.respawns.length = 0;
    const result = await h.surface.clear({ topicKey: 23, principal: OPERATOR, origin: 'conversational', discloseInReply: true });
    expect(result.ok).toBe(true);
    expect(h.store.resolve(23)?.framework ?? null).toBeNull();
    expect(h.store.get(23)?.intendedProfile).toBeNull(); // shadow superseded too
    expect(h.respawns).toEqual([]); // NO profile-triggered kill outside fully-live
    expect(result.reply).toContain('next session restart');
  });

  it('clearing a new-axis pin while DISABLED is permitted (a CLEAR is not a new pin)', async () => {
    // Pin landed while fully-live; the feature is then disabled.
    const live = harness(FULLY_LIVE);
    await live.surface.applyWrite({
      topicKey: 23, patch: { thinkingMode: 'high' }, principal: OPERATOR, origin: 'conversational', discloseInReply: true,
    });
    // Same store dir, now disabled regime.
    const h = harness(FLEET_REGIME);
    const result = await h.surface.applyWrite({
      topicKey: 23, patch: { thinkingMode: null }, principal: OPERATOR, origin: 'conversational', discloseInReply: true,
    });
    expect(result.ok).toBe(true);
    expect(result.appliedLive).toEqual(['thinkingMode']);
    expect(h.store.resolve(23)?.thinkingMode ?? null).toBeNull();
  });

  it('re-apply of a parked pin works under enabled:false AND under dryRun:true (no kill, told out loud)', async () => {
    for (const regime of [FLEET_REGIME, DEV_REGIME]) {
      const dir = fs.mkdtempSync(path.join(tmpDir, 'reapply-'));
      const store = new TopicProfileStore({
        stateFilePath: path.join(dir, 'topic-profiles.json'),
        isDryRun: () => regime.dryRun,
      });
      // park a pin the way the §10.4 breaker does
      await store.mutate(23, { framework: 'codex-cli', updatedBy: 'telegram:777' });
      await store.parkAndRevert(23, 'spawn-failures', null);
      expect(store.parkedFor(23)).not.toBeNull();

      const respawns: string[] = [];
      const resolver = new TopicProfileResolver({
        store,
        defaultFramework: () => 'claude-code',
        configTopicFrameworks: () => ({}),
        configProfileDefaults: () => ({}),
        frameworkDefaultModels: () => ({}),
        tierEscalationConfig: () => undefined,
        localModelBinding: () => null,
        frameworkBinaryPath: () => null,
      });
      const surface = new TopicProfileWriteSurface({
        store, resolver, regime: () => regime,
        boundOperator: () => ({ platform: 'telegram', uid: '777' }),
        localModelBinding: () => null,
        legacyFrameworkRespawn: async (k) => { respawns.push(k); return { respawned: true }; },
        disclose: async () => {},
        audit: () => 'seq-x',
        reapplyCooldownMs: 0, // cooldown elapsed
      });
      const result = await surface.reapply({ topicKey: 23, principal: OPERATOR, origin: 'conversational', discloseInReply: true });
      expect(result.ok).toBe(true);
      expect(store.resolve(23)?.framework).toBe('codex-cli'); // restored LIVE
      expect(store.parkedFor(23)).toBeNull();
      expect(respawns).toEqual([]); // application arm: no kill outside fully-live
      expect(result.reply).toContain('next session restart');
    }
  });

  it('§10.4 cooldown: re-applying a just-tripped pin requires an explicit confirm', async () => {
    const h = harness(FLEET_REGIME, { reapplyCooldownMs: 600_000 });
    await h.store.mutate(23, { framework: 'codex-cli', updatedBy: 'telegram:777' });
    await h.store.parkAndRevert(23, 'spawn-failures', null);
    const first = await h.surface.reapply({ topicKey: 23, principal: OPERATOR, origin: 'conversational' });
    expect(first.ok).toBe(false);
    expect(first.needsConfirm).toBe(true);
    expect(first.reply).toContain('apply it anyway');
    // parked stays parked until the confirm
    expect(h.store.parkedFor(23)).not.toBeNull();
    const confirmed = await h.surface.reapply({ topicKey: 23, principal: OPERATOR, origin: 'propose-confirm', confirmed: true, discloseInReply: true });
    expect(confirmed.ok).toBe(true);
    expect(h.store.parkedFor(23)).toBeNull();
  });

  it('re-apply after a superseding new pin is refused with the supersession wording', async () => {
    const h = harness(FLEET_REGIME);
    await h.store.mutate(23, { framework: 'codex-cli', updatedBy: 'telegram:777' });
    await h.store.parkAndRevert(23, 'spawn-failures', null);
    // a deliberate operator pin supersedes the parked state in the same mutate
    await h.surface.applyWrite({
      topicKey: 23, patch: { framework: 'claude-code' }, principal: OPERATOR, origin: 'conversational', discloseInReply: true,
    });
    const result = await h.surface.reapply({ topicKey: 23, principal: OPERATOR, origin: 'conversational' });
    expect(result.ok).toBe(false);
    expect(result.reply).toContain("you've since set a new profile");
  });
});

describe('§10.3 undo', () => {
  it('restores the previous snapshot; a framework-arm undo names the CONTINUATION loss (legacy regime)', async () => {
    const h = harness(FLEET_REGIME);
    await h.surface.applyWrite({
      topicKey: 23, patch: { framework: 'codex-cli' }, principal: OPERATOR, origin: 'slash-route', discloseInReply: true,
    });
    h.respawns.length = 0;
    const result = await h.surface.undo({ topicKey: 23, principal: OPERATOR, origin: 'conversational', discloseInReply: true });
    expect(result.ok).toBe(true);
    expect(h.store.resolve(23)?.framework ?? null).toBeNull(); // back to pre-pin
    expect(h.respawns).toEqual(['23']); // the undo IS a framework write — legacy respawn
    // §8 round-12: nothing parked to resume on the legacy path — loss named
    expect(result.reply).toContain("can't be resumed across that switch");
  });

  it('refuses plainly when nothing to undo', async () => {
    const h = harness(FLEET_REGIME);
    const result = await h.surface.undo({ topicKey: 23, principal: OPERATOR, origin: 'conversational' });
    expect(result.ok).toBe(false);
    expect(result.reply).toContain('Nothing to undo yet');
  });

  it('a second undo returns to the intermediate state (previous shifts per disclosed write)', async () => {
    const h = harness(FULLY_LIVE);
    await h.surface.applyWrite({ topicKey: 23, patch: { thinkingMode: 'low' }, principal: OPERATOR, origin: 'conversational', discloseInReply: true });
    await h.surface.applyWrite({ topicKey: 23, patch: { thinkingMode: 'max' }, principal: OPERATOR, origin: 'conversational', discloseInReply: true });
    const undo = await h.surface.undo({ topicKey: 23, principal: OPERATOR, origin: 'conversational', discloseInReply: true });
    expect(undo.ok).toBe(true);
    expect(h.store.resolve(23)?.thinkingMode).toBe('low');
  });
});

describe('§10.1 — principal gates', () => {
  it('refuses a non-bound-operator sender (the refusal tier)', async () => {
    const h = harness(FLEET_REGIME, { boundUid: '999' });
    const result = await h.surface.applyWrite({
      topicKey: 23, patch: { framework: 'codex-cli' }, principal: OPERATOR, origin: 'conversational',
    });
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe('not-bound-operator');
    expect(h.store.resolve(23)).toBeNull();
    expect(h.audits.some(a => a.reason === 'not-bound-operator')).toBe(true);
  });

  it('refuses when no operator can be derived, with plain wording', async () => {
    const h = harness(FLEET_REGIME, { boundUid: null });
    const result = await h.surface.applyWrite({
      topicKey: 23, patch: { framework: 'codex-cli' }, principal: OPERATOR, origin: 'conversational',
    });
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe('no-bound-operator');
  });

  it('token-trust writes stamp api-token and refuse unbound topics', async () => {
    const bound = harness(FLEET_REGIME);
    const ok = await bound.surface.applyWrite({
      topicKey: 23, patch: { framework: 'codex-cli' }, principal: { kind: 'token' }, origin: 'http',
    });
    expect(ok.ok).toBe(true);
    expect(bound.store.resolve(23)?.updatedBy).toBe('api-token');
    // §8: an HTTP write posts the disclosure to the topic conversation
    expect(bound.disclosures.length).toBe(1);
    expect(bound.disclosures[0].text).toContain('via API');

    const unbound = harness(FLEET_REGIME, { boundUid: null });
    const refused = await unbound.surface.applyWrite({
      topicKey: 24, patch: { framework: 'codex-cli' }, principal: { kind: 'token' }, origin: 'http',
    });
    expect(refused.ok).toBe(false);
    expect(refused.refusal?.reason).toBe('no-bound-operator');
  });

  it('operator writes stamp the platform:uid principal server-side', async () => {
    const h = harness(FLEET_REGIME);
    await h.surface.applyWrite({
      topicKey: 23, patch: { framework: 'codex-cli' }, principal: OPERATOR, origin: 'conversational', discloseInReply: true,
    });
    expect(h.store.resolve(23)?.updatedBy).toBe('telegram:777');
  });
});

describe('§10.2 validation at the write boundary', () => {
  it('refuses an off-enum model with the profile unchanged', async () => {
    const h = harness(FULLY_LIVE);
    const result = await h.surface.applyWrite({
      topicKey: 23, patch: { model: 'gpt-7-ultra' }, principal: OPERATOR, origin: 'conversational',
    });
    expect(result.ok).toBe(false);
    expect(result.refusal?.validation?.failure).toBe('off-enum');
    expect(h.store.resolve(23)).toBeNull();
  });

  it('refuses model+modelTier both set (merge-result §4 hard refusal)', async () => {
    const h = harness(FULLY_LIVE);
    await h.surface.applyWrite({
      topicKey: 23, patch: { modelTier: 'escalated' }, principal: OPERATOR, origin: 'conversational', discloseInReply: true,
    });
    const result = await h.surface.applyWrite({
      topicKey: 23, patch: { model: 'claude-opus-4-8' }, principal: OPERATOR, origin: 'conversational',
    });
    expect(result.ok).toBe(false);
    expect(result.refusal?.validation?.failure).toBe('model-and-tier-both-set');
    expect(h.store.resolve(23)?.modelTier).toBe('escalated'); // unchanged
  });

  it('refuses a cloud model pin while a local-model binding is active (§5.2 precedence)', async () => {
    const h = harness(FULLY_LIVE, { localBinding: true });
    const result = await h.surface.applyWrite({
      topicKey: 23, patch: { model: 'claude-opus-4-8' }, principal: OPERATOR, origin: 'conversational',
    });
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe('local-model-binding-active');
    expect(result.reply).toContain('local-model binding');
  });
});

describe('propose-confirm echo (§10.1 — server-rendered, split named)', () => {
  it('names each arm\'s fate under the fleet regime', () => {
    const h = harness(FLEET_REGIME);
    const echo = h.surface.renderProposalEcho(23, { framework: 'codex-cli', thinkingMode: 'high' });
    expect(echo.ok).toBe(true);
    if (echo.ok) {
      expect(echo.echo).toContain('framework → codex-cli: switches now (live)');
      expect(echo.echo).toContain("thinkingMode → high: refused — the thinkingMode control isn't enabled");
    }
  });

  it('names the dry-run intent fate under the dev regime', () => {
    const h = harness(DEV_REGIME);
    const echo = h.surface.renderProposalEcho(23, { thinkingMode: 'high' });
    expect(echo.ok).toBe(true);
    if (echo.ok) expect(echo.echo).toContain('recorded as a dry-run intent');
  });

  it('refuses an invalid proposal at propose time (never armed)', () => {
    const h = harness(DEV_REGIME);
    const echo = h.surface.renderProposalEcho(23, { model: 'rm -rf /' });
    expect(echo.ok).toBe(false);
  });
});

describe('readout (§9 framework-aware disclosure)', () => {
  it('a codex-pinned topic never claims the ultra mandate fires', async () => {
    const h = harness(FLEET_REGIME);
    await h.surface.applyWrite({
      topicKey: 23, patch: { framework: 'codex-cli' }, principal: OPERATOR, origin: 'slash-route', discloseInReply: true,
    });
    const readout = h.surface.renderReadout(23);
    expect(readout).toContain("won't auto-escalate");
    expect(readout).not.toContain('still auto-escalates');
  });

  it('a parked pin is surfaced with the re-apply path', async () => {
    const h = harness(FLEET_REGIME);
    await h.store.mutate(23, { framework: 'codex-cli', updatedBy: 'telegram:777' });
    await h.store.parkAndRevert(23, 'spawn-failures', null);
    expect(h.surface.renderReadout(23)).toContain('re-apply');
  });
});
