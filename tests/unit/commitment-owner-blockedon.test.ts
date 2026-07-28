/**
 * Unit tests for the C1+C2 "The Agent Carries the Loop" commitment state model
 * (spec docs/specs/agent-owned-followthrough.md §4.1).
 *
 * Covers BOTH sides of every decision boundary (Testing Integrity — semantic
 * correctness):
 *   - record() defaults: owner='agent', blockedOn='none'.
 *   - owner/blockedOn enum validation (valid accepted, invalid rejected).
 *   - Forward gate: blockedOn:'user-authorization' requires a non-empty
 *     actionClass (named privileged action); blank is refused.
 *   - actionClass normalization (trimmed; empty/whitespace → undefined/inert).
 *   - loadStore() migration back-fill: legacy rows default owner='agent',
 *     blockedOn='none' — and NEVER 'user-authorization' (no invented
 *     operator-approval obligation by omission).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createTmpState(): { stateDir: string; cleanup: () => void } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-owner-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ updates: { autoApply: true } }, null, 2),
  );
  return {
    stateDir,
    cleanup: () =>
      SafeFsExecutor.safeRmSync(stateDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/commitment-owner-blockedon.test.ts',
      }),
  };
}

function makeTracker(stateDir: string): CommitmentTracker {
  return new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
}

const baseInput = {
  userRequest: 'do the thing',
  agentResponse: 'on it',
  type: 'one-time-action' as const,
};

describe('CommitmentTracker — owner ⟂ blockedOn state model (C1+C2)', () => {
  let stateDir: string;
  let cleanup: () => void;
  let tracker: CommitmentTracker;

  beforeEach(() => {
    ({ stateDir, cleanup } = createTmpState());
    tracker = makeTracker(stateDir);
  });
  afterEach(() => cleanup());

  it('defaults owner=agent, blockedOn=none when unspecified', () => {
    const c = tracker.record({ ...baseInput });
    expect(c.owner).toBe('agent');
    expect(c.blockedOn).toBe('none');
    expect(c.actionClass).toBeUndefined();
  });

  it('accepts every valid owner/blockedOn combination', () => {
    expect(tracker.record({ ...baseInput, owner: 'agent', blockedOn: 'none' }).blockedOn).toBe('none');
    expect(tracker.record({ ...baseInput, owner: 'agent', blockedOn: 'external' }).blockedOn).toBe(
      'external',
    );
    expect(tracker.record({ ...baseInput, owner: 'user', blockedOn: 'user-input' }).owner).toBe('user');
  });

  it('rejects an invalid owner', () => {
    // @ts-expect-error — deliberately invalid value
    expect(() => tracker.record({ ...baseInput, owner: 'nobody' })).toThrow(/invalid owner/);
  });

  it('rejects an invalid blockedOn', () => {
    // @ts-expect-error — deliberately invalid value
    expect(() => tracker.record({ ...baseInput, owner: 'user', blockedOn: 'whenever' })).toThrow(
      /invalid blockedOn/,
    );
  });

  it('forward gate: blockedOn=user-authorization WITHOUT actionClass is refused', () => {
    expect(() =>
      tracker.record({ ...baseInput, owner: 'user', blockedOn: 'user-authorization' }),
    ).toThrow(/requires a non-empty actionClass/);
  });

  it('forward gate: blockedOn=user-authorization WITH actionClass succeeds and persists it', () => {
    const c = tracker.record({
      ...baseInput,
      owner: 'user',
      blockedOn: 'user-authorization',
      actionClass: 'prod-deploy',
    });
    expect(c.blockedOn).toBe('user-authorization');
    expect(c.actionClass).toBe('prod-deploy');
  });

  it('normalizes actionClass: trims, and whitespace-only becomes inert (undefined)', () => {
    const trimmed = tracker.record({ ...baseInput, actionClass: '  external-send  ' });
    expect(trimmed.actionClass).toBe('external-send');
    const blank = tracker.record({ ...baseInput, actionClass: '   ' });
    expect(blank.actionClass).toBeUndefined();
  });

  it('loadStore() back-fills legacy rows to owner=agent, blockedOn=none — never user-authorization', () => {
    // Write a v2 store with a legacy row missing owner/blockedOn entirely.
    const storePath = path.join(stateDir, 'state', 'commitments.json');
    const legacy = {
      version: 2,
      commitments: [
        {
          id: 'CMT-001',
          userRequest: 'send the code as soon as I get it',
          agentResponse: 'will do',
          type: 'one-time-action',
          status: 'pending',
          createdAt: new Date().toISOString(),
          verificationCount: 0,
          violationCount: 0,
        },
      ],
    };
    fs.writeFileSync(storePath, JSON.stringify(legacy, null, 2));

    const reloaded = makeTracker(stateDir);
    const c = reloaded.get('CMT-001');
    expect(c).toBeTruthy();
    expect(c?.owner).toBe('agent');
    expect(c?.blockedOn).toBe('none');
    expect(c?.blockedOn).not.toBe('user-authorization');
  });

  // ── recordProbe (§4.4 dependency-probe data path) ──
  it('recordProbe sets lastProbe on a blockedOn:external commitment', () => {
    const c = tracker.record({ ...baseInput, owner: 'agent', blockedOn: 'external' });
    const r = tracker.recordProbe(c.id, { checked: 'CI run #42', readinessSignal: 'green checks' });
    expect(r).toBeTruthy();
    expect(r?.lastProbe?.checked).toBe('CI run #42');
    expect(r?.lastProbe?.readinessSignal).toBe('green checks');
    expect(typeof r?.lastProbe?.at).toBe('string');
  });

  it('recordProbe is a no-op (null) on a non-external commitment', () => {
    const c = tracker.record({ ...baseInput, owner: 'agent', blockedOn: 'none' });
    expect(tracker.recordProbe(c.id, { checked: 'x', readinessSignal: 'y' })).toBeNull();
  });

  it('recordProbe refuses a blank probe (no falsifiable evidence)', () => {
    const c = tracker.record({ ...baseInput, owner: 'agent', blockedOn: 'external' });
    expect(tracker.recordProbe(c.id, { checked: '  ', readinessSignal: 'y' })).toBeNull();
    expect(tracker.recordProbe(c.id, { checked: 'x', readinessSignal: '' })).toBeNull();
  });

  it('recordProbe is a no-op on an unknown id', () => {
    expect(tracker.recordProbe('CMT-999', { checked: 'x', readinessSignal: 'y' })).toBeNull();
  });

  // ── transitionState (§4.1 guarded in-place transition) ──
  it('transitionState changes owner/blockedOn IN PLACE (same id, status preserved)', () => {
    const c = tracker.record({ ...baseInput, owner: 'agent', blockedOn: 'none' });
    const r = tracker.transitionState(c.id, { blockedOn: 'external' });
    expect(r.id).toBe(c.id); // same commitment — no close-and-reopen
    expect(r.status).toBe('pending');
    expect(r.blockedOn).toBe('external');
    expect(r.owner).toBe('agent');
  });

  it('transitionState re-runs the gate: → user-authorization without actionClass throws', () => {
    const c = tracker.record({ ...baseInput, owner: 'agent', blockedOn: 'none' });
    expect(() => tracker.transitionState(c.id, { owner: 'user', blockedOn: 'user-authorization' })).toThrow(
      /requires a non-empty actionClass/,
    );
  });

  it('transitionState → user-authorization WITH actionClass succeeds', () => {
    const c = tracker.record({ ...baseInput });
    const r = tracker.transitionState(c.id, { owner: 'user', blockedOn: 'user-authorization', actionClass: 'prod-deploy' });
    expect(r.blockedOn).toBe('user-authorization');
    expect(r.actionClass).toBe('prod-deploy');
  });

  it('transitionState rejects an invalid enum', () => {
    const c = tracker.record({ ...baseInput });
    expect(() => tracker.transitionState(c.id, { blockedOn: 'whenever' })).toThrow(/invalid blockedOn/);
  });

  it('transitionState throws on a terminal commitment', () => {
    const c = tracker.record({ ...baseInput });
    tracker.deliver(c.id); // → terminal
    expect(() => tracker.transitionState(c.id, { blockedOn: 'external' })).toThrow(/terminal/);
  });

  it('transitionState throws on an unknown id', () => {
    expect(() => tracker.transitionState('CMT-999', { blockedOn: 'external' })).toThrow(/not found/);
  });

  it('transitionState can set supersededBy', () => {
    const c = tracker.record({ ...baseInput });
    const r = tracker.transitionState(c.id, { supersededBy: 'CMT-050' });
    expect(r.supersededBy).toBe('CMT-050');
  });
});
