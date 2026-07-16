/**
 * Unit tests — TopicProfileOrchestrator (TOPIC-PROFILE-SPEC §8 / §9-consult /
 * §10.4 / §14).
 *
 * Implements the spec's §8 truth table as ORCHESTRATION tests (the pure §7
 * matrix rows live in classifyProfileChange.test.ts):
 *  - two-phase lock + trailing-edge debounce: N writes → ONE respawn against
 *    the final resolved profile; net-unchanged → ZERO respawns, loop closed
 *    out loud; undo snapshot shifts once per disclosed burst.
 *  - idle re-confirmed at kill time inside the lock: busy/unconfirmed at
 *    dequeue defers (unconfirmed IS busy); autonomous-registry consult
 *    defers an idle-pane-but-active-run; protected sessions are NEVER
 *    profile-killed and "switch now" never overrides protection.
 *  - kill-path precision: fresh respawns PARK (not delete) both resume
 *    stores' entries before the kill + set the durable suppression marker;
 *    same-framework resume respawns kill via the resume-saving path.
 *  - §10.4 breaker: attribution allowlist, ambient classes never count,
 *    reset on success, trip → park + revert + un-park + notify + immediate
 *    respawn, LIVE in every regime; cooldown confirm; supersession-by-pin.
 *  - §14 dry-run shadow: new-axis writes shadow under dryRun, the flip
 *    clears (never promotes), recovery writes are live in every regime with
 *    a regime-governed application arm; exempted framework writes land live
 *    with the §8 shadow observing.
 *  - global stagger cap K; boot reconcile sweep (divergence + stale
 *    escalation marker); disclosure rate cap with delta-carrying overflow.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  TopicProfileOrchestrator,
  type AppliedProfile,
  type OrchestratorConfig,
  type ProfileSpawnFailureClass,
  type RespawnSpawnOutcome,
  type TopicProfileOrchestratorDeps,
} from '../../src/core/TopicProfileOrchestrator.js';
import type { ResolvedTopicProfile } from '../../src/core/TopicProfileResolver.js';
import type { IdleReading } from '../../src/core/classifyProfileChange.js';
import type { CodexSpawnFence, FenceCaptureResult } from '../../src/core/CodexResumeMap.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';

const CLAUDE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const ROLLOUT_ID = '11111111-2222-4333-8444-555555555555';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await sleep(10);
  }
}

// The parked pin becomes visible mid-trip (parkAndRevert assigns entry.parked
// before its internal flushDurably await yields), so polling parkedFor races
// the trip's continuation (unpark → breaker-revert audit → disclosure →
// respawn enqueue). The breaker-revert audit is emitted after every other
// synchronous trip side-effect — by the time a poll observes it, they have
// all landed. Wait on that, never on parkedFor.
async function waitForBreakerTrip(h: Harness): Promise<void> {
  await waitUntil(() => h.audits.some((a) => a.type === 'breaker-revert'));
}

interface Harness {
  orch: TopicProfileOrchestrator;
  store: TopicProfileStore;
  cfg: OrchestratorConfig;
  tmpDir: string;
  disclosures: Array<{ topic: string; text: string; auditSeq: number }>;
  audits: Array<Record<string, unknown>>;
  kills: Array<{ name: string; mode: 'resume' | 'fresh' }>;
  spawns: Array<{
    topicKey: string;
    framework: IntelligenceFramework;
    model: string | undefined;
    method: string;
    resumeId?: string;
  }>;
  sessions: Map<string, { sessionName: string; cwd: string } | null>;
  idle: { value: IdleReading };
  autonomous: { active: boolean };
  protectedSet: Set<string>;
  claude: {
    readyFlag: boolean;
    parks: string[];
    unparks: string[];
  };
  codex: {
    entry: string | null;
    captureResult: FenceCaptureResult;
    parks: string[];
    unparks: string[];
  };
  fence: { value: CodexSpawnFence | null };
  escalation: { markers: Map<string, { model: string }>; cleared: string[] };
  verification: {
    inFlightSwapConfirmedRecently: boolean;
    thinkingOffOnResumeVerified: boolean;
    thinkingLevelResumeVerified: boolean;
    crossModelResumeVerified: boolean;
    claudeThinkingControlAvailable: boolean;
  };
  inFlightSwap: ReturnType<typeof vi.fn>;
  spawnImpl: { fn: ((topicKey: string, resolved: ResolvedTopicProfile) => Promise<RespawnSpawnOutcome>) | null };
  nowRef: { value: number | null };
}

const harnesses: Harness[] = [];

function makeHarness(cfgOverrides: Partial<OrchestratorConfig> = {}): Harness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-orch-'));
  const store = new TopicProfileStore({
    stateFilePath: path.join(tmpDir, 'topic-profiles.json'),
  });

  const cfg: OrchestratorConfig = {
    enabled: true,
    dryRun: false,
    respawnDebounceMs: 40,
    frameworkSwitchDebounceMs: 100,
    maxConcurrentProfileRespawns: 2,
    spawnFailureBreakerThreshold: 3,
    switchNowConfirmTtlMs: 300_000,
    ...cfgOverrides,
  };

  const disclosures: Harness['disclosures'] = [];
  const audits: Harness['audits'] = [];
  const kills: Harness['kills'] = [];
  const spawns: Harness['spawns'] = [];
  const sessions = new Map<string, { sessionName: string; cwd: string } | null>();
  const idle = { value: 'confirmed-idle' as IdleReading };
  const autonomous = { active: false };
  const protectedSet = new Set<string>();
  const claude = { readyFlag: true, parks: [] as string[], unparks: [] as string[] };
  const codex = {
    entry: null as string | null,
    captureResult: { outcome: 'none', candidateCount: 0 } as FenceCaptureResult,
    parks: [] as string[],
    unparks: [] as string[],
  };
  const fence = { value: null as CodexSpawnFence | null };
  const escalation = { markers: new Map<string, { model: string }>(), cleared: [] as string[] };
  const verification = {
    inFlightSwapConfirmedRecently: true,
    thinkingOffOnResumeVerified: true,
    thinkingLevelResumeVerified: true,
    crossModelResumeVerified: true,
    claudeThinkingControlAvailable: true,
  };
  const inFlightSwap = vi.fn(async () => ({ status: 'swapped' as const }));
  const spawnImpl = { fn: null as Harness['spawnImpl']['fn'] };
  const nowRef = { value: null as number | null };

  const resolveProfile = (topicKey: string): ResolvedTopicProfile => {
    const pin = store.resolve(topicKey);
    return {
      framework: (pin?.framework ?? 'claude-code') as IntelligenceFramework,
      model: pin?.model ?? undefined,
      modelTier: pin?.modelTier ?? null,
      thinkingMode: pin?.thinkingMode ?? undefined,
      escalationOverride: pin?.escalationOverride ?? 'inherit',
      sources: { framework: 'test', model: 'test', thinkingMode: 'test' },
      notices: [],
    };
  };

  const deps: TopicProfileOrchestratorDeps = {
    store,
    resolveProfile,
    sessions: {
      getSessionForTopic: (k) => sessions.get(k) ?? null,
      listTopicSessions: () =>
        [...sessions.entries()]
          .filter(([, v]) => v !== null)
          .map(([topicKey, v]) => ({ topicKey, sessionName: v!.sessionName })),
      readIdle: () => idle.value,
      killForResume: async (name) => {
        kills.push({ name, mode: 'resume' });
        return true;
      },
      killFresh: async (name) => {
        kills.push({ name, mode: 'fresh' });
        return true;
      },
      spawn: async (topicKey, resolved, directive) => {
        const outcome = spawnImpl.fn
          ? await spawnImpl.fn(topicKey, resolved)
          : ({ ok: true } as RespawnSpawnOutcome);
        spawns.push({
          topicKey,
          framework: resolved.framework,
          model: resolved.model,
          method: directive.method,
          resumeId: directive.resumeId,
        });
        return outcome;
      },
    },
    claudeResume: {
      ready: () => claude.readyFlag,
      resumeId: () => (claude.readyFlag ? CLAUDE_UUID : null),
      park: (k, r) => claude.parks.push(`${k}:${r}`),
      unpark: (k) => {
        claude.unparks.push(String(k));
        return true;
      },
    },
    codexResume: {
      get: () => codex.entry,
      captureAtKill: async () => codex.captureResult,
      park: (k, r) => codex.parks.push(`${k}:${r}`),
      unpark: (k) => {
        codex.unparks.push(String(k));
        return true;
      },
    },
    escalation: {
      activeMarker: (k) => escalation.markers.get(k) ?? null,
      listMarkerTopics: () => [...escalation.markers.keys()],
      clearMarkerAndReleaseLease: (k) => {
        escalation.markers.delete(k);
        escalation.cleared.push(k);
      },
    },
    inFlightSwap: { swap: inFlightSwap },
    autonomousActive: () => autonomous.active,
    isProtectedSession: (name) => protectedSet.has(name),
    codexFence: () => fence.value,
    verification: () => ({ ...verification }),
    getConfig: () => ({ ...cfg }),
    disclose: (topic, text, meta) => disclosures.push({ topic, text, auditSeq: meta.auditSeq }),
    audit: (event) => audits.push(event),
    stateFilePath: path.join(tmpDir, 'orchestrator-state.json'),
    now: () => nowRef.value ?? Date.now(),
  };

  const orch = new TopicProfileOrchestrator(deps);
  const h: Harness = {
    orch,
    store,
    cfg,
    tmpDir,
    disclosures,
    audits,
    kills,
    spawns,
    sessions,
    idle,
    autonomous,
    protectedSet,
    claude,
    codex,
    fence,
    escalation,
    verification,
    inFlightSwap,
    spawnImpl,
    nowRef,
  };
  harnesses.push(h);
  return h;
}

function liveSession(h: Harness, key = '7', name = 'sess-7'): void {
  h.sessions.set(key, { sessionName: name, cwd: '/tmp/project' });
}

const OP = { updatedBy: 'telegram:111', origin: 'conversational' as const };

afterEach(() => {
  vi.useRealTimers();
  for (const h of harnesses.splice(0)) {
    h.orch.dispose();
    SafeFsExecutor.safeRmSync(h.tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/TopicProfileOrchestrator.test.ts:afterEach',
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Write regimes (§5.2 / §14)
// ─────────────────────────────────────────────────────────────────────────────

describe('write regimes', () => {
  it('refuses a NEW-axis pin while disabled (existing pins stay honored on read)', async () => {
    const h = makeHarness({ enabled: false });
    const r = await h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP);
    expect(r.outcome).toBe('refused');
    expect(h.store.resolve('7')).toBeNull();
  });

  it('permits a CLEAR while disabled — §5.2(b) recovery write, live in every regime', async () => {
    const h = makeHarness();
    await h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP);
    h.cfg.enabled = false;
    const r = await h.orch.requestProfileChange('7', { model: null }, OP);
    expect(r.outcome).toBe('applied');
    expect(h.store.resolve('7')?.model ?? null).toBeNull();
  });

  it('system safety-writes are exempt from the disabled refusal', async () => {
    const h = makeHarness({ enabled: false });
    const r = await h.orch.requestProfileChange(
      '7',
      { framework: 'claude-code' },
      { updatedBy: 'system:spawn-fallback', origin: 'system' },
    );
    expect(r.outcome).toBe('applied');
  });

  it('under dryRun a NEW-axis write lands in the SHADOW field — resolution never sees it', async () => {
    const h = makeHarness({ dryRun: true });
    const r = await h.orch.requestProfileChange('7', { thinkingMode: 'high' }, OP);
    expect(r.outcome).toBe('shadow-recorded');
    expect(r.reply).toContain('[dry-run]');
    expect(h.store.resolve('7')).toBeNull();
    expect(h.store.get('7')?.intendedProfile?.fields.thinkingMode).toBe('high');
    expect(h.disclosures.some((d) => d.text.includes('[dry-run]'))).toBe(true);
  });

  it('the dryRun true→false flip CLEARS shadows — never promotes — with one coalesced notice', async () => {
    const h = makeHarness({ dryRun: true });
    await h.orch.requestProfileChange('7', { thinkingMode: 'high' }, OP);
    h.cfg.dryRun = false;
    h.orch.tick();
    await waitUntil(() => h.disclosures.some((d) => d.text.includes('dry-run ended')));
    expect(h.store.get('7')?.intendedProfile).toBeNull();
    // Promotion never happens — the live profile is untouched.
    expect(h.store.resolve('7')).toBeNull();
  });

  it('fully-live write applies, discloses immediately with the audit stamp, and shifts the undo snapshot', async () => {
    const h = makeHarness();
    const r = await h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP);
    expect(r.outcome).toBe('applied');
    expect(h.store.resolve('7')?.model).toBe('claude-opus-4-8');
    // Dormant topic: §8 — an accepted write to a session-less topic still discloses.
    expect(h.disclosures.length).toBe(1);
    expect(h.disclosures[0].text).toContain('next session start');
    expect(h.disclosures[0].text).toMatch(/\[#\d+\]/);
    expect(h.store.previousFor('7')).toBeNull(); // pre-burst was empty
  });

  it('§5.2(d) exempted framework write lands LIVE regardless of enabled/dryRun, with disclosure-of-record metadata', async () => {
    const h = makeHarness({ enabled: false, dryRun: true }); // shipped fleet config
    const r = await h.orch.applyExemptFrameworkWrite('7', 'codex-cli', OP);
    expect(r.changed).toBe(true);
    expect(r.meta.allowDuplicate).toBe(true);
    expect(r.auditSeq).toBeGreaterThan(0);
    expect(h.store.resolve('7')?.framework).toBe('codex-cli');
    // No shadow, no [dry-run] operator message, no §8 machinery engaged.
    expect(h.store.get('7')?.intendedProfile).toBeNull();
    expect(h.disclosures.length).toBe(0);
    expect(h.orch.pendingFor('7')).toBeNull();
  });

  it('§14 canary: under enabled+dryRun the exempted framework write logs the §8 SHADOW decision (audit-only)', async () => {
    const h = makeHarness({ enabled: true, dryRun: true });
    liveSession(h);
    await h.orch.applyExemptFrameworkWrite('7', 'codex-cli', OP);
    const shadow = h.audits.find((a) => a.type === 'dry-run-shadow-decision');
    expect(shadow).toBeTruthy();
    expect(h.disclosures.length).toBe(0); // never operator-facing
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Debounce, coalescing, net-unchanged, undo cadence (§8)
// ─────────────────────────────────────────────────────────────────────────────

describe('debounce + coalescing', () => {
  it('N writes within the window collapse to ONE respawn against the FINAL resolved profile', async () => {
    const h = makeHarness();
    liveSession(h);
    await h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP);
    await h.orch.requestProfileChange('7', { model: 'claude-fable-5' }, OP);
    await waitUntil(() => h.spawns.length === 1);
    await sleep(120); // no second respawn after the window
    expect(h.spawns.length).toBe(1);
    expect(h.spawns[0].model).toBe('claude-fable-5');
    expect(h.kills.length).toBe(1);
    expect(h.kills[0].mode).toBe('resume'); // same-framework model change resumes
    expect(h.spawns[0].resumeId).toBe(CLAUDE_UUID);
  });

  it('a net-unchanged toggle fires ZERO respawns and closes its loop out loud', async () => {
    const h = makeHarness();
    liveSession(h);
    // Establish the live characteristics.
    await h.orch.requestProfileChange('7', { framework: 'claude-code', model: 'claude-opus-4-8' }, OP);
    await waitUntil(() => h.spawns.length === 1);
    // Toggle away and back within one window.
    await h.orch.requestProfileChange('7', { model: 'claude-fable-5' }, OP);
    await h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP);
    await waitUntil(() =>
      h.disclosures.some((d) => d.text.includes("back where you started")),
    );
    expect(h.spawns.length).toBe(1); // only the original apply — zero for the toggle
  });

  it('undo snapshot shifts ONCE per disclosed burst — undo restores the pre-burst profile', async () => {
    const h = makeHarness();
    liveSession(h);
    await h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP);
    await waitUntil(() => h.spawns.length === 1);
    // Burst of two writes in one window.
    await h.orch.requestProfileChange('7', { model: 'claude-fable-5' }, OP);
    await h.orch.requestProfileChange('7', { thinkingMode: 'high' }, OP);
    await waitUntil(() => h.spawns.length === 2);
    // previous = the profile before the BURST, not the intermediate write.
    expect(h.store.previousFor('7')?.model).toBe('claude-opus-4-8');
    expect(h.store.previousFor('7')?.thinkingMode ?? null).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idle re-confirmation at kill time, autonomous consult, protection (§8)
// ─────────────────────────────────────────────────────────────────────────────

describe('idle re-confirm + deferral', () => {
  it('busy at dequeue defers — idle at write time is never carried to the kill', async () => {
    const h = makeHarness();
    liveSession(h);
    await h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP);
    h.idle.value = 'busy'; // went busy between classify and kill
    await sleep(120);
    expect(h.kills.length).toBe(0);
    expect(h.orch.pendingFor('7')?.deferred).toBe(true);
    // Goes idle → the periodic tick carries the deferred swap.
    h.idle.value = 'confirmed-idle';
    h.orch.tick();
    await waitUntil(() => h.spawns.length === 1);
  });

  it('UNCONFIRMED at kill time is treated as busy — never permission to kill', async () => {
    const h = makeHarness();
    liveSession(h);
    h.idle.value = 'unconfirmed';
    await h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP);
    await sleep(120);
    expect(h.kills.length).toBe(0);
    expect(h.orch.pendingFor('7')?.deferred).toBe(true);
  });

  it('pane-idle is not task-done: an active autonomous run defers the swap', async () => {
    const h = makeHarness();
    liveSession(h);
    h.autonomous.active = true; // confirmed-idle pane, active time-boxed run
    await h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP);
    await sleep(120);
    expect(h.kills.length).toBe(0);
    h.autonomous.active = false;
    h.orch.tick();
    await waitUntil(() => h.spawns.length === 1);
  });

  it('protected sessions are NEVER profile-killed — and "switch now" never overrides protection', async () => {
    const h = makeHarness();
    liveSession(h);
    h.idle.value = 'busy';
    // Arm a busy framework switch (this arms the switch-now confirm)...
    await h.orch.requestProfileChange('7', { framework: 'codex-cli' }, OP);
    await sleep(200);
    expect(h.kills.length).toBe(0);
    // ...then the session becomes protected before the confirm fires.
    h.protectedSet.add('sess-7');
    const fired = await h.orch.handleSwitchNow('7');
    expect(fired.fired).toBe(true); // the confirm fires...
    await sleep(150);
    expect(h.kills.length).toBe(0); // ...but protection holds at the kill slot
    expect(
      h.disclosures.some((d) => d.text.includes('protected')),
    ).toBe(true);
  });

  it('busy framework switch: refuse-or-confirm wording + "switch now" interrupts when confirmed', async () => {
    const h = makeHarness();
    liveSession(h);
    h.idle.value = 'busy';
    const r = await h.orch.requestProfileChange('7', { framework: 'codex-cli' }, OP);
    expect(r.outcome).toBe('applied'); // the PIN persists — only the respawn defers
    expect(r.reply).toContain('mid-task');
    expect(r.reply).toContain('switch now');
    const fired = await h.orch.handleSwitchNow('7');
    expect(fired.fired).toBe(true);
    await waitUntil(() => h.kills.length === 1);
    expect(h.kills[0].mode).toBe('fresh');
    await waitUntil(() => h.spawns.length === 1);
    expect(h.spawns[0].framework).toBe('codex-cli');
    expect(h.spawns[0].method).toBe('continuation');
  });

  it('"switch now" with no armed pending switch is a plain no-op', async () => {
    const h = makeHarness();
    const r = await h.orch.handleSwitchNow('7');
    expect(r.fired).toBe(false);
    expect(r.reply).toContain('no pending switch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Kill-path precision: parking, suppression, resume gating (§8)
// ─────────────────────────────────────────────────────────────────────────────

describe('kill-path precision', () => {
  it('a framework switch PARKS both resume stores before a FRESH kill and discloses the honest loss', async () => {
    const h = makeHarness();
    liveSession(h);
    h.spawnImpl.fn = async () => ({
      ok: true,
      applied: {
        framework: 'codex-cli',
        model: 'gpt-5.5',
        modelTier: null,
        thinkingMode: null,
        effort: null,
      },
    });
    await h.orch.requestProfileChange('7', { framework: 'codex-cli' }, OP);
    await waitUntil(() => h.spawns.length === 1);
    expect(h.claude.parks).toContain('7:mid-framework-switch');
    expect(h.codex.parks).toContain('7:mid-framework-switch');
    expect(h.kills[0].mode).toBe('fresh'); // never the resume-saving kill
    expect(
      h.disclosures.some((d) => d.text.includes("full transcript can't follow")),
    ).toBe(true);
    expect(
      h.disclosures.some((d) => d.text.includes('Now driving this topic: Codex door, gpt-5.5 model.')),
    ).toBe(true);
    // Profile-triggered kill cleared the escalation marker slot.
    expect(h.escalation.cleared).toContain('7');
  });

  it('the resume-writer gates refuse during suppression and on framework mismatch', async () => {
    const h = makeHarness();
    liveSession(h);
    // Make the switch's spawn fail with an AMBIENT class — suppression stays.
    h.spawnImpl.fn = async () => ({ ok: false, failureClass: 'tmux' as ProfileSpawnFailureClass });
    await h.orch.requestProfileChange('7', { framework: 'codex-cli' }, OP);
    await waitUntil(() => h.spawns.length === 1);
    expect(h.orch.suppressionActive('7')).toBe(true);
    expect(h.orch.claudeResumeWriteGate(7).allowed).toBe(false);
    expect(h.orch.claudeResumeWriteGate(7).reason).toBe('mid-framework-switch');
    expect(h.orch.codexResumeWriteGate(7).allowed).toBe(false);
    // Successful spawn clears suppression; gates then follow the resolved framework.
    h.spawnImpl.fn = null;
    h.orch.recordSpawnSuccess('7', {
      framework: 'codex-cli',
      model: null,
      modelTier: null,
      thinkingMode: null,
    });
    expect(h.orch.suppressionActive('7')).toBe(false);
    expect(h.orch.codexResumeWriteGate(7).allowed).toBe(true);
    expect(h.orch.claudeResumeWriteGate(7).allowed).toBe(false); // framework mismatch
  });

  it('claude resume NOT ready degrades to CONTINUATION with the loss disclosed up front', async () => {
    const h = makeHarness();
    liveSession(h);
    h.claude.readyFlag = false;
    h.verification.crossModelResumeVerified = true;
    await h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP);
    await waitUntil(() => h.spawns.length === 1);
    expect(h.spawns[0].method).toBe('continuation');
    expect(h.spawns[0].resumeId).toBeUndefined();
    expect(h.kills[0].mode).toBe('fresh');
  });

  it('codex same-framework change resumes on a fence-captured rollout-id', async () => {
    const h = makeHarness();
    liveSession(h);
    // Topic lives on codex.
    h.orch.recordSpawnSuccess('7', {
      framework: 'codex-cli',
      model: null,
      modelTier: null,
      thinkingMode: null,
    });
    await h.store.mutate('7', { framework: 'codex-cli', updatedBy: 'seed' });
    h.fence.value = { spawnedAt: Date.now() - 1000, cwd: '/tmp/project' };
    h.codex.captureResult = { outcome: 'captured', rolloutId: ROLLOUT_ID, candidateCount: 1 };
    await h.orch.requestProfileChange('7', { thinkingMode: 'high' }, OP);
    await waitUntil(() => h.spawns.length === 1);
    expect(h.spawns[0].method).toBe('resume');
    expect(h.spawns[0].resumeId).toBe(ROLLOUT_ID);
    expect(h.kills[0].mode).toBe('resume');
  });

  it('an AMBIGUOUS codex fence captures nothing — the row degrades to CONTINUATION, disclosed', async () => {
    const h = makeHarness();
    liveSession(h);
    h.orch.recordSpawnSuccess('7', {
      framework: 'codex-cli',
      model: null,
      modelTier: null,
      thinkingMode: null,
    });
    await h.store.mutate('7', { framework: 'codex-cli', updatedBy: 'seed' });
    h.fence.value = { spawnedAt: Date.now() - 1000, cwd: '/tmp/project' };
    h.codex.captureResult = { outcome: 'ambiguous', candidateCount: 2 };
    await h.orch.requestProfileChange('7', { thinkingMode: 'high' }, OP);
    await waitUntil(() => h.spawns.length === 1);
    expect(h.spawns[0].method).toBe('continuation');
    expect(h.disclosures.some((d) => d.text.includes('recent history'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// In-flight row (§7) + unconfirmed choreography (§14)
// ─────────────────────────────────────────────────────────────────────────────

describe('in-flight swap', () => {
  it('a tier-only pin on a confirmed-idle session with a fresh canary swaps in flight — no session death', async () => {
    const h = makeHarness();
    liveSession(h);
    await h.orch.requestProfileChange('7', { modelTier: 'escalated' }, OP);
    await waitUntil(() => h.inFlightSwap.mock.calls.length === 1);
    expect(h.inFlightSwap).toHaveBeenCalledWith('sess-7', 'escalated');
    expect(h.kills.length).toBe(0);
    expect(h.spawns.length).toBe(0);
  });

  it('an UNCONFIRMED in-flight attempt never guesses again — the retry uses kill+resume', async () => {
    const h = makeHarness();
    liveSession(h);
    h.inFlightSwap.mockResolvedValueOnce({ status: 'unconfirmed' });
    await h.orch.requestProfileChange('7', { modelTier: 'escalated' }, OP);
    await waitUntil(() => h.inFlightSwap.mock.calls.length === 1);
    await sleep(50);
    expect(h.kills.length).toBe(0); // deferred, not guessed
    h.orch.tick();
    await waitUntil(() => h.spawns.length === 1);
    expect(h.inFlightSwap.mock.calls.length).toBe(1); // no second injection
    expect(h.kills.length).toBe(1);
    expect(h.kills[0].mode).toBe('resume');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10.4 circuit breaker — LIVE in every regime
// ─────────────────────────────────────────────────────────────────────────────

describe('circuit breaker (§10.4)', () => {
  it('trips after N attributable failures: parks the pin, reverts, un-parks, notifies, respawns immediately', async () => {
    const h = makeHarness();
    liveSession(h);
    // Live characteristics differ from the (post-revert) default profile so
    // the immediate keep-working respawn is observable.
    h.orch.recordSpawnSuccess('7', {
      framework: 'claude-code',
      model: 'claude-opus-4-8',
      modelTier: null,
      thinkingMode: null,
    });
    await h.store.mutate('7', { model: 'claude-bad-model', updatedBy: OP.updatedBy }, { shiftPrevious: true });
    for (let i = 0; i < 3; i++) h.orch.recordSpawnFailure('7', 'cli-not-found');
    await waitForBreakerTrip(h);
    expect(h.store.parkedFor('7')?.profile.model).toBe('claude-bad-model');
    // Reverted to last-known-good (here: the empty pre-pin profile → defaults).
    expect(h.store.resolve('7')?.model ?? null).toBeNull();
    expect(h.claude.unparks).toContain('7'); // matching-framework entry un-parked
    expect(
      h.disclosures.some((d) => d.text.includes("Couldn't launch with the requested profile")),
    ).toBe(true);
    expect(h.disclosures.some((d) => d.text.includes('re-apply'))).toBe(true);
    // Immediate keep-working respawn toward the reverted profile.
    await waitUntil(() => h.spawns.length >= 1);
    expect(h.spawns.at(-1)?.model).toBeUndefined();
    const audit = h.audits.find((a) => a.type === 'breaker-revert');
    expect(audit?.principal).toBe('system:circuit-breaker');
  });

  it('ambient failure classes NEVER increment the counter', async () => {
    const h = makeHarness();
    await h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP);
    for (const cls of ['quota', 'tmux', 'disk', 'unknown', 'resume-id-mismatch'] as const) {
      h.orch.recordSpawnFailure('7', cls);
    }
    await sleep(50);
    expect(h.store.get('7')?.breakerCount ?? 0).toBe(0);
    expect(h.store.parkedFor('7')).toBeNull();
  });

  it('the counter resets on any successful spawn', async () => {
    const h = makeHarness();
    await h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP);
    h.orch.recordSpawnFailure('7', 'cli-not-found');
    h.orch.recordSpawnFailure('7', 'launch-arg-rejected');
    await waitUntil(() => (h.store.get('7')?.breakerCount ?? 0) === 2);
    h.orch.recordSpawnSuccess('7', {
      framework: 'claude-code',
      model: 'claude-opus-4-8',
      modelTier: null,
      thinkingMode: null,
    });
    await waitUntil(() => (h.store.get('7')?.breakerCount ?? 0) === 0);
  });

  it('the breaker is LIVE under enabled:false + dryRun:true — a real revert fires', async () => {
    const h = makeHarness();
    await h.orch.requestProfileChange('7', { model: 'claude-bad-model' }, OP);
    h.cfg.enabled = false;
    h.cfg.dryRun = true;
    for (let i = 0; i < 3; i++) h.orch.recordSpawnFailure('7', 'model-rejected-by-account');
    await waitForBreakerTrip(h);
    expect(h.store.resolve('7')?.model ?? null).toBeNull(); // really reverted
    expect(
      h.disclosures.some((d) => d.text.includes("Couldn't launch")),
    ).toBe(true);
  });

  it('re-applying the profile that JUST tripped requires the cooldown confirm; the confirm applies it', async () => {
    const h = makeHarness();
    await h.orch.requestProfileChange('7', { model: 'claude-bad-model' }, OP);
    for (let i = 0; i < 3; i++) h.orch.recordSpawnFailure('7', 'cli-not-found');
    await waitForBreakerTrip(h);

    const r = await h.orch.requestRecoveryWrite('7', 'reapply', OP);
    expect(r.outcome).toBe('confirm-required');
    expect(r.reply).toContain('failed 3 times');
    expect(h.store.resolve('7')?.model ?? null).toBeNull(); // not applied yet

    const fired = await h.orch.fireConfirm('7');
    expect(fired.fired).toBe(true);
    await waitUntil(() => h.store.resolve('7')?.model === 'claude-bad-model');
    expect(h.store.parkedFor('7')).toBeNull(); // re-apply consumed the parked pin
  });

  it('re-apply with nothing parked is refused plainly', async () => {
    const h = makeHarness();
    const r = await h.orch.requestRecoveryWrite('7', 'reapply', OP);
    expect(r.outcome).toBe('refused');
    expect(r.reply).toContain('nothing parked');
  });

  it('a new deliberate operator pin SUPERSEDES the parked state — re-apply afterwards is refused', async () => {
    const h = makeHarness();
    await h.orch.requestProfileChange('7', { model: 'claude-bad-model' }, OP);
    for (let i = 0; i < 3; i++) h.orch.recordSpawnFailure('7', 'cli-not-found');
    await waitForBreakerTrip(h);

    const pin = await h.orch.requestProfileChange('7', { model: 'claude-fable-5' }, OP);
    expect(pin.outcome).toBe('applied');
    expect(pin.outcome === 'applied' && pin.supersededParked).toBe(true);
    expect(h.store.parkedFor('7')).toBeNull();

    const r = await h.orch.requestRecoveryWrite('7', 'reapply', OP);
    expect(r.outcome).toBe('refused');
  });

  it('§5.2(b): a recovery re-apply in a GATED regime is a live write with NO profile-triggered kill, told out loud', async () => {
    const h = makeHarness();
    liveSession(h);
    await h.orch.requestProfileChange('7', { model: 'claude-bad-model' }, OP);
    for (let i = 0; i < 3; i++) h.orch.recordSpawnFailure('7', 'cli-not-found');
    await waitForBreakerTrip(h);
    const killsAfterTrip = h.kills.length;

    h.cfg.dryRun = true; // gated regime (the shipped dev config)
    const r = await h.orch.requestRecoveryWrite('7', 'reapply', OP, { confirmed: true });
    expect(r.outcome).toBe('applied');
    expect(r.reply).toContain('next session restart');
    expect(h.store.resolve('7')?.model).toBe('claude-bad-model'); // LIVE, not shadowed
    expect(h.store.get('7')?.intendedProfile).toBeNull();
    await sleep(120);
    expect(h.kills.length).toBe(killsAfterTrip); // no kill in the gated regime
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Confirm slot — ONE armed slot per topic (§8/§10.1(c)/§10.4)
// ─────────────────────────────────────────────────────────────────────────────

describe('confirm slot', () => {
  it('arming supersedes the prior confirm — a bare "yes" fires only the most-recently-echoed one', async () => {
    const h = makeHarness();
    let firstRan = false;
    let secondRan = false;
    h.orch.armConfirm('7', 'switch-now', 'first?', async () => {
      firstRan = true;
      return 'first';
    });
    h.orch.armConfirm('7', 'propose', 'second?', async () => {
      secondRan = true;
      return 'second';
    });
    const fired = await h.orch.fireConfirm('7');
    expect(fired.reply).toBe('second');
    expect(secondRan).toBe(true);
    expect(firstRan).toBe(false);
    expect(h.audits.some((a) => a.type === 'confirm-superseded')).toBe(true);
  });

  it('an expired confirm is refused plainly', async () => {
    const h = makeHarness();
    h.nowRef.value = 1_000_000;
    h.orch.armConfirm('7', 'propose', 'do it?', async () => 'done');
    h.nowRef.value = 1_000_000 + h.cfg.switchNowConfirmTtlMs + 1;
    const fired = await h.orch.fireConfirm('7');
    expect(fired.fired).toBe(false);
    expect(fired.reply).toContain('expired');
  });

  it('a confirm answering a SUPERSEDED echo (older platform message id) is refused toward re-echo', async () => {
    const h = makeHarness();
    h.orch.armConfirm('7', 'propose', 'latest?', async () => 'done');
    h.orch.attachConfirmEchoMessageId('7', 100);
    const stale = await h.orch.fireConfirm('7', { messageId: 99 });
    expect(stale.fired).toBe(false);
    expect(stale.reply).toContain('confirm the new version');
    const fresh = await h.orch.fireConfirm('7', { messageId: 101 });
    expect(fresh.fired).toBe(true);
  });

  it('re-proposal churn past the rate bound tears the slot down and audits a suspicion signal', async () => {
    const h = makeHarness();
    for (let i = 0; i < 6; i++) {
      h.orch.armConfirm('7', 'propose', `echo ${i}`, async () => 'x');
    }
    expect(h.orch.armedConfirm('7')).toBeNull(); // torn down
    expect(h.audits.some((a) => a.type === 'confirm-arm-churn' && a.suspicion === true)).toBe(true);
    const fired = await h.orch.fireConfirm('7');
    expect(fired.fired).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Global stagger (§8)
// ─────────────────────────────────────────────────────────────────────────────

describe('global respawn stagger', () => {
  it('profile-triggered respawns share the global cap K — never more than K in flight', async () => {
    const h = makeHarness({ maxConcurrentProfileRespawns: 1 });
    let concurrent = 0;
    let peak = 0;
    h.spawnImpl.fn = async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await sleep(60);
      concurrent -= 1;
      return { ok: true };
    };
    for (const key of ['1', '2', '3']) {
      h.sessions.set(key, { sessionName: `sess-${key}`, cwd: `/tmp/p${key}` });
      await h.orch.requestProfileChange(key, { model: 'claude-opus-4-8' }, OP);
    }
    await waitUntil(() => h.spawns.length === 3, 5000);
    expect(peak).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot reconcile sweep (§8)
// ─────────────────────────────────────────────────────────────────────────────

describe('boot reconcile sweep', () => {
  it('detects store-vs-live divergence and arms the normal debounced respawn (fully-live)', async () => {
    const h = makeHarness();
    liveSession(h);
    // Live session launched with defaults; a pin landed (e.g. mid-debounce
    // server death) that was never applied.
    h.orch.recordSpawnSuccess('7', {
      framework: 'claude-code',
      model: null,
      modelTier: null,
      thinkingMode: null,
    });
    await h.store.mutate('7', { model: 'claude-fable-5', updatedBy: OP.updatedBy }, { shiftPrevious: true });
    h.orch.bootReconcileSweep();
    expect(h.disclosures.some((d) => d.text.includes("wasn't applied before my last restart"))).toBe(true);
    await waitUntil(() => h.spawns.length === 1);
    expect(h.spawns[0].model).toBe('claude-fable-5');
  });

  it('clears a STALE escalation marker (session gone) before computing expected-live', () => {
    const h = makeHarness();
    h.escalation.markers.set('99', { model: 'claude-fable-5' });
    h.orch.bootReconcileSweep();
    expect(h.escalation.cleared).toContain('99');
  });

  it('a session legitimately on the escalated model under inherit is NOT divergence (no ping-pong)', async () => {
    const h = makeHarness();
    liveSession(h);
    await h.store.mutate('7', { modelTier: 'default', updatedBy: OP.updatedBy });
    h.escalation.markers.set('7', { model: 'claude-fable-5' });
    h.orch.recordSpawnSuccess('7', {
      framework: 'claude-code',
      model: 'claude-fable-5', // live on the escalated model
      modelTier: null,
      thinkingMode: null,
    });
    h.orch.bootReconcileSweep();
    await sleep(120);
    expect(h.spawns.length).toBe(0);
    expect(h.kills.length).toBe(0);
  });

  it('in a GATED regime the sweep observes divergence (audit) without arming a kill', async () => {
    const h = makeHarness({ dryRun: true });
    liveSession(h);
    h.orch.recordSpawnSuccess('7', {
      framework: 'claude-code',
      model: null,
      modelTier: null,
      thinkingMode: null,
    });
    await h.store.mutate('7', { model: 'claude-fable-5', updatedBy: OP.updatedBy });
    h.orch.bootReconcileSweep();
    await sleep(120);
    expect(h.spawns.length).toBe(0);
    expect(h.audits.some((a) => a.type === 'boot-sweep-divergence-observed')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Disclosure rate cap (§8 round-6/round-9)
// ─────────────────────────────────────────────────────────────────────────────

describe('disclosure rate cap', () => {
  it('caps per-topic disclosures and emits a DELTA-CARRYING overflow summary', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      // Dormant topic — every escalationOverride flip discloses immediately
      // (no respawn slot to coalesce into).
      const flip = (i: number) =>
        h.orch.requestProfileChange(
          '7',
          { escalationOverride: i % 2 === 0 ? 'suppress' : 'inherit' },
          OP,
        );
      for (let i = 0; i < 6; i++) await flip(i);
      // First 4 disclosed individually; 5th + 6th entered the overflow period.
      expect(h.disclosures.length).toBe(4);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(h.disclosures.length).toBe(5);
      const summary = h.disclosures[4].text;
      expect(summary).toContain('was:');
      expect(summary).toContain('now:');
      expect(summary).toContain('2 changes');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 interplay
// ─────────────────────────────────────────────────────────────────────────────

describe('§9 escalation interplay', () => {
  it('runExclusive serializes through the same per-topic lock as the WRITE phase', async () => {
    const h = makeHarness();
    const order: string[] = [];
    const a = h.orch.runExclusive('7', async () => {
      order.push('escalation-start');
      await sleep(30);
      order.push('escalation-end');
    });
    const b = h.orch.requestProfileChange('7', { model: 'claude-opus-4-8' }, OP).then(() => {
      order.push('write-done');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['escalation-start', 'escalation-end', 'write-done']);
  });

  it('a profile-triggered kill clears the escalation marker and releases the lease', async () => {
    const h = makeHarness();
    liveSession(h);
    h.escalation.markers.set('7', { model: 'claude-fable-5' });
    await h.orch.requestProfileChange('7', { framework: 'codex-cli' }, OP);
    await waitUntil(() => h.kills.length === 1);
    expect(h.escalation.cleared).toContain('7');
    expect(h.escalation.markers.has('7')).toBe(false);
  });
});
