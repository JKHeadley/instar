/**
 * Unit tests — classifyProfileChange FULL truth table (TOPIC-PROFILE-SPEC
 * §7 / §11): every matrix row — Claude/Codex, idle/busy, canary on/off,
 * rollout-id present/absent, off↔on thinking, net-unchanged no-op — plus the
 * round-4 contingencies (cross-model resume, level-change resume, pane-idle
 * vs autonomous-run, protected sessions).
 */

import { describe, it, expect } from 'vitest';
import {
  classifyProfileChange,
  type ProfileSessionState,
} from '../../src/core/classifyProfileChange.js';
import type { TopicProfile } from '../../src/core/TopicProfileStore.js';

const p = (over: Partial<TopicProfile> = {}): TopicProfile => ({
  updatedAt: '2026-06-11T00:00:00.000Z',
  updatedBy: 'op:1',
  framework: 'claude-code',
  ...over,
});

const idleSession = (over: Partial<ProfileSessionState> = {}): ProfileSessionState => ({
  exists: true,
  idle: 'confirmed-idle',
  autonomousActive: false,
  isProtected: false,
  claudeResumeReady: true,
  codexRolloutCaptured: true,
  inFlightSwapConfirmedRecently: true,
  thinkingOffOnResumeVerified: true,
  thinkingLevelResumeVerified: true,
  crossModelResumeVerified: true,
  claudeThinkingControlAvailable: true,
  ...over,
});

describe('classifyProfileChange — no-op / dormant rows', () => {
  it('net-unchanged → none/none', () => {
    const c = classifyProfileChange(p({ model: 'opus' }), p({ model: 'opus' }), idleSession());
    expect(c.swapMethod).toBe('none');
    expect(c.requiresRespawn).toBe(false);
  });

  it('dormant topic (no session) → applies at next spawn', () => {
    const c = classifyProfileChange(p(), p({ model: 'opus' }), idleSession({ exists: false }));
    expect(c.swapMethod).toBe('none');
    expect(c.reason).toContain('next session start');
  });

  it('escalationOverride-only change never moves the live session (§9)', () => {
    const c = classifyProfileChange(
      p({ escalationOverride: 'inherit' }),
      p({ escalationOverride: 'suppress' }),
      idleSession(),
    );
    expect(c.requiresRespawn).toBe(false);
    expect(c.swapMethod).toBe('none');
  });
});

describe('classifyProfileChange — Claude modelTier rows', () => {
  it('tier pin, confirmed-idle, canary passed → in-flight, none-loss', () => {
    const c = classifyProfileChange(p(), p({ modelTier: 'escalated' }), idleSession());
    expect(c.swapMethod).toBe('in-flight');
    expect(c.expectedLoss).toBe('none');
    expect(c.requiresRespawn).toBe(false);
  });

  it('tier pin, canary NOT passed → kill + --resume, none-loss', () => {
    const c = classifyProfileChange(
      p(),
      p({ modelTier: 'escalated' }),
      idleSession({ inFlightSwapConfirmedRecently: false }),
    );
    expect(c.swapMethod).toBe('resume');
    expect(c.expectedLoss).toBe('none');
  });

  it('tier pin, idle UNCONFIRMED → fails toward kill+--resume (never in-flight injection)', () => {
    const c = classifyProfileChange(
      p(),
      p({ modelTier: 'escalated' }),
      idleSession({ idle: 'unconfirmed' }),
    );
    expect(c.swapMethod).not.toBe('in-flight');
    expect(c.deferUntilIdle).toBe(true);
  });

  it('tier pin without verified cross-model resume → fresh (recent-only, disclosed)', () => {
    const c = classifyProfileChange(
      p(),
      p({ modelTier: 'escalated' }),
      idleSession({ inFlightSwapConfirmedRecently: false, crossModelResumeVerified: false }),
    );
    expect(c.swapMethod).toBe('continuation');
    expect(c.expectedLoss).toBe('recent-only');
    expect(c.freshRespawn).toBe(true);
  });
});

describe('classifyProfileChange — Claude explicit-model rows', () => {
  it('model change, resume UUID captured + cross-model verified → resume, none-loss', () => {
    const c = classifyProfileChange(p(), p({ model: 'claude-opus-4-8' }), idleSession());
    expect(c.swapMethod).toBe('resume');
    expect(c.expectedLoss).toBe('none');
  });

  it('model change, resume UUID NOT captured → CONTINUATION, recent-only (the symmetric Claude row)', () => {
    const c = classifyProfileChange(
      p(),
      p({ model: 'claude-opus-4-8' }),
      idleSession({ claudeResumeReady: false }),
    );
    expect(c.swapMethod).toBe('continuation');
    expect(c.expectedLoss).toBe('recent-only');
    expect(c.freshRespawn).toBe(true);
  });

  it('model change, cross-model resume UNVERIFIED → fresh respawn (wedge-class risk)', () => {
    const c = classifyProfileChange(
      p(),
      p({ model: 'claude-opus-4-8' }),
      idleSession({ crossModelResumeVerified: false }),
    );
    expect(c.swapMethod).toBe('continuation');
    expect(c.reason).toContain('wedge');
  });
});

describe('classifyProfileChange — Claude thinking rows', () => {
  it('level change (no off↔on), verified → resume, none-loss', () => {
    const c = classifyProfileChange(
      p({ thinkingMode: 'low' }),
      p({ thinkingMode: 'high' }),
      idleSession(),
    );
    expect(c.swapMethod).toBe('resume');
    expect(c.expectedLoss).toBe('none');
  });

  it('off↔on toggle, verified → resume, none-loss', () => {
    const c = classifyProfileChange(
      p({ thinkingMode: 'off' }),
      p({ thinkingMode: 'high' }),
      idleSession(),
    );
    expect(c.swapMethod).toBe('resume');
  });

  it('off↔on toggle, UNVERIFIED → fresh, recent-only (documented wedge class)', () => {
    const c = classifyProfileChange(
      p({ thinkingMode: 'off' }),
      p({ thinkingMode: 'high' }),
      idleSession({ thinkingOffOnResumeVerified: false }),
    );
    expect(c.swapMethod).toBe('continuation');
    expect(c.expectedLoss).toBe('recent-only');
  });

  it('level change UNVERIFIED carries the same contingent cell (round-4)', () => {
    const c = classifyProfileChange(
      p({ thinkingMode: 'low' }),
      p({ thinkingMode: 'high' }),
      idleSession({ thinkingLevelResumeVerified: false }),
    );
    expect(c.swapMethod).toBe('continuation');
  });

  it('no usable thinking control → disclosed no-op, no respawn (§6 contingency)', () => {
    const c = classifyProfileChange(
      p(),
      p({ thinkingMode: 'max' }),
      idleSession({ claudeThinkingControlAvailable: false }),
    );
    expect(c.requiresRespawn).toBe(false);
    expect(c.swapMethod).toBe('none');
    expect(c.reason).toContain('no-op');
  });
});

describe('classifyProfileChange — Claude effort rows', () => {
  it('effort-only change, resume-ready → resume, none-loss, effort-specific reason (NOT thinking)', () => {
    const c = classifyProfileChange(p({ effort: 'high' }), p({ effort: 'max' }), idleSession());
    expect(c.swapMethod).toBe('resume');
    expect(c.expectedLoss).toBe('none');
    expect(c.requiresRespawn).toBe(true);
    expect(c.reason).toContain('effort change');
    expect(c.reason).not.toContain('thinking');
  });

  it('effort-only change, no resume UUID → fresh, recent-only', () => {
    const c = classifyProfileChange(
      p({ effort: 'low' }),
      p({ effort: 'max' }),
      idleSession({ claudeResumeReady: false }),
    );
    expect(c.swapMethod).toBe('continuation');
    expect(c.expectedLoss).toBe('recent-only');
    expect(c.reason).toContain('effort change');
  });

  it('effort-only change is NOT gated on the thinking verification flags (the bug this row fixes)', () => {
    const c = classifyProfileChange(
      p({ effort: 'high' }),
      p({ effort: 'max' }),
      idleSession({ thinkingLevelResumeVerified: false, thinkingOffOnResumeVerified: false }),
    );
    expect(c.swapMethod).toBe('resume');
    expect(c.expectedLoss).toBe('none');
  });

  it('setting effort from unset → resume (none-loss), effort reason', () => {
    const c = classifyProfileChange(p(), p({ effort: 'max' }), idleSession());
    expect(c.requiresRespawn).toBe(true);
    expect(c.reason).toContain('effort change');
  });
});

describe('classifyProfileChange — Codex rows', () => {
  it('codex change with fence-captured rollout-id → resume, none-loss', () => {
    const c = classifyProfileChange(
      p({ framework: 'codex-cli' }),
      p({ framework: 'codex-cli', thinkingMode: 'high' }),
      idleSession(),
    );
    expect(c.swapMethod).toBe('resume');
    expect(c.expectedLoss).toBe('none');
  });

  it('codex change, rollout-id NOT captured → CONTINUATION, recent-only', () => {
    const c = classifyProfileChange(
      p({ framework: 'codex-cli' }),
      p({ framework: 'codex-cli', model: 'gpt-5.5' }),
      idleSession({ codexRolloutCaptured: false }),
    );
    expect(c.swapMethod).toBe('continuation');
    expect(c.expectedLoss).toBe('recent-only');
    expect(c.freshRespawn).toBe(true);
  });
});

describe('classifyProfileChange — framework switch rows', () => {
  it('idle switch → CONTINUATION bootstrap, recent-only, fresh respawn (parks resume entries)', () => {
    const c = classifyProfileChange(p(), p({ framework: 'codex-cli' }), idleSession());
    expect(c.swapMethod).toBe('continuation');
    expect(c.expectedLoss).toBe('recent-only');
    expect(c.freshRespawn).toBe(true);
    expect(c.refuseOrConfirm).toBe(false);
  });

  it('busy switch → refuse-or-confirm, NEVER a silent mid-work kill', () => {
    const c = classifyProfileChange(
      p(),
      p({ framework: 'codex-cli' }),
      idleSession({ idle: 'busy' }),
    );
    expect(c.refuseOrConfirm).toBe(true);
    expect(c.deferUntilIdle).toBe(true);
  });

  it('pane-idle but ACTIVE AUTONOMOUS RUN is busy (round-4: pane-idle ≠ task-done)', () => {
    const c = classifyProfileChange(
      p(),
      p({ framework: 'codex-cli' }),
      idleSession({ autonomousActive: true }),
    );
    expect(c.refuseOrConfirm).toBe(true);
    expect(c.deferUntilIdle).toBe(true);
  });

  it('protected sessions flag protectedDeferral (never profile-killed, §8)', () => {
    const c = classifyProfileChange(
      p(),
      p({ model: 'claude-opus-4-8' }),
      idleSession({ isProtected: true }),
    );
    expect(c.protectedDeferral).toBe(true);
  });

  it('gemini target → honest CONTINUATION (no verified resume path)', () => {
    const c = classifyProfileChange(
      p({ framework: 'gemini-cli' }),
      p({ framework: 'gemini-cli', thinkingMode: 'high' }),
      idleSession(),
    );
    expect(c.swapMethod).toBe('continuation');
    expect(c.expectedLoss).toBe('recent-only');
  });
});
