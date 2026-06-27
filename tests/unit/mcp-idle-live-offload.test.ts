/**
 * Idle-live MCP offload (dynamic-MCP lever 2) — pure eligibility logic.
 * The load-bearing safety: a session that is — or MIGHT be — using its tools is
 * ALWAYS kept. Every gate is tested both sides; uncertainty fails CLOSED (keep).
 * This decision is invariant to the load-on-demand trigger/baseline choices.
 */
import { describe, it, expect } from 'vitest';
import {
  decideIdleLiveOffload,
  isHeavyMcpSignature,
  DEFAULT_IDLE_LIVE_OFFLOAD_CONFIG,
  type IdleLiveOffloadInput,
  type IdleLiveOffloadConfig,
} from '../../src/monitoring/mcpIdleLiveOffload.js';

const cfg = (over: Partial<IdleLiveOffloadConfig> = {}): IdleLiveOffloadConfig =>
  ({ ...DEFAULT_IDLE_LIVE_OFFLOAD_CONFIG, enabled: true, idleOffloadMs: 1000, ...over });

// A heavy, live, not-keep-warm, definitely-idle-past-window proc — the one eligible shape.
const eligibleInput = (over: Partial<IdleLiveOffloadInput> = {}): IdleLiveOffloadInput => ({
  signatureId: 'playwright-mcp',
  ownerLive: true,
  midToolUse: false,
  continuousIdleMs: 5000,
  keepWarm: false,
  ...over,
});

describe('isHeavyMcpSignature', () => {
  it('playwright (Chromium) is heavy; the light stdio bridges are not', () => {
    expect(isHeavyMcpSignature('playwright-mcp')).toBe(true);
    expect(isHeavyMcpSignature('instar-mcp-stdio')).toBe(false);
    expect(isHeavyMcpSignature('mcp-remote')).toBe(false);
  });
});

describe('decideIdleLiveOffload — eligible only when ALL gates clear', () => {
  it('eligible: heavy + live + not-keep-warm + definitely-idle past the window', () => {
    expect(decideIdleLiveOffload(eligibleInput(), cfg())).toEqual({ eligible: true, reason: 'idle-live-offload' });
  });

  it('KEEP when the feature is disabled (today behavior)', () => {
    expect(decideIdleLiveOffload(eligibleInput(), cfg({ enabled: false })).eligible).toBe(false);
  });

  it('KEEP a light signature (never offload the cheap stdio bridge)', () => {
    expect(decideIdleLiveOffload(eligibleInput({ signatureId: 'instar-mcp-stdio' }), cfg()))
      .toEqual({ eligible: false, reason: 'not-heavy' });
  });

  it('KEEP when keep-warm-pinned', () => {
    expect(decideIdleLiveOffload(eligibleInput({ keepWarm: true }), cfg()))
      .toEqual({ eligible: false, reason: 'keep-warm' });
  });

  it('KEEP (fail-closed) when the session is mid-tool-use', () => {
    expect(decideIdleLiveOffload(eligibleInput({ midToolUse: true }), cfg()))
      .toEqual({ eligible: false, reason: 'mid-tool-use' });
  });

  it('KEEP (fail-closed) when the mid-tool-use signal is UNKNOWN (null)', () => {
    expect(decideIdleLiveOffload(eligibleInput({ midToolUse: null }), cfg()))
      .toEqual({ eligible: false, reason: 'mid-tool-use-unknown' });
  });

  it('KEEP when the idle clock has not crossed the window', () => {
    expect(decideIdleLiveOffload(eligibleInput({ continuousIdleMs: 500 }), cfg({ idleOffloadMs: 1000 })))
      .toEqual({ eligible: false, reason: 'idle-window-not-reached' });
  });

  it('KEEP when the owner is not live (dead/orphan is the existing reaper path)', () => {
    expect(decideIdleLiveOffload(eligibleInput({ ownerLive: false }), cfg()))
      .toEqual({ eligible: false, reason: 'owner-not-live' });
  });

  it('the default config is dark (disabled) with a ~30min idle window', () => {
    expect(DEFAULT_IDLE_LIVE_OFFLOAD_CONFIG.enabled).toBe(false);
    expect(DEFAULT_IDLE_LIVE_OFFLOAD_CONFIG.idleOffloadMs).toBe(30 * 60 * 1000);
  });
});
