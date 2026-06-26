/**
 * Operator-channel-sacred (OUTBOUND) — MessagingToneGate availability-failure
 * fail-direction tiered by recipientClass. Spec: outbound-gate-tiered-fail-direction.
 *
 * The boundary under test: an AVAILABILITY failure (capacity-shed / provider-error /
 * unparseable-after-retry — i.e. NO usable verdict) DELIVERS on the operator's own
 * channel (so the operator is never sealed out) but HOLDS for external recipients
 * (No Silent Degradation). A real CONTENT BLOCK verdict always holds, on every
 * channel. Tiering is OFF by default ('always' mode = today's behavior) and only
 * an explicit 'tiered' mode + a structurally-resolved 'operator' recipient delivers.
 */
import { describe, it, expect } from 'vitest';
import { MessagingToneGate, type ToneGateConfig } from '../../src/core/MessagingToneGate.js';
import { LlmCapacityUnavailableError } from '../../src/core/SpawnCapIntelligenceProvider.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

const ok = (): IntelligenceProvider => ({ evaluate: async () => JSON.stringify({ pass: true, issue: '', suggestion: '' }) } as unknown as IntelligenceProvider);
const block = (): IntelligenceProvider => ({ evaluate: async () => JSON.stringify({ pass: false, rule: 'B2_FILE_PATH', issue: 'File path exposed', suggestion: 'Reference concepts.' }) } as unknown as IntelligenceProvider);
const providerError = (): IntelligenceProvider => ({ evaluate: async () => { throw new Error('provider exhausted'); } } as unknown as IntelligenceProvider);
const capacityShed = (): IntelligenceProvider => ({ evaluate: async () => { throw new LlmCapacityUnavailableError('spawn cap saturated'); } } as unknown as IntelligenceProvider);
const unparseable = (): IntelligenceProvider => ({ evaluate: async (_p: string, _o?: IntelligenceOptions) => 'not json at all — no verdict' } as unknown as IntelligenceProvider);

const TIERED: ToneGateConfig = { failClosedMode: 'tiered' };

describe('tone gate — operator-channel availability tiering', () => {
  // ── DEFAULT (always) mode preserves today's behavior ───────────────────────
  it("DEFAULT 'always' mode: operator + provider-error → HOLD (no tiering without opt-in)", async () => {
    const r = await new MessagingToneGate(providerError()).review('status', { channel: 'telegram', recipientClass: 'operator' });
    expect(r.pass).toBe(false);
    expect(r.failedClosed).toBe(true);
    expect(r.failedOpenOperatorChannel).toBeUndefined();
  });

  // ── tiered: operator DELIVERS on each availability failure ──────────────────
  it("tiered: operator + provider-error → DELIVER (failedOpenOperatorChannel)", async () => {
    const r = await new MessagingToneGate(providerError(), TIERED).review('status', { channel: 'telegram', recipientClass: 'operator' });
    expect(r.pass).toBe(true);
    expect(r.failedOpenOperatorChannel).toBe(true);
  });
  it("tiered: operator + capacity-shed → DELIVER (delivery spawns nothing; fork-bomb floor intact)", async () => {
    const r = await new MessagingToneGate(capacityShed(), TIERED).review('status', { channel: 'telegram', recipientClass: 'operator' });
    expect(r.pass).toBe(true);
    expect(r.failedOpenOperatorChannel).toBe(true);
  });
  it("tiered: operator + unparseable-after-retry → DELIVER", async () => {
    const r = await new MessagingToneGate(unparseable(), TIERED).review('status', { channel: 'telegram', recipientClass: 'operator' });
    expect(r.pass).toBe(true);
    expect(r.failedOpenOperatorChannel).toBe(true);
  });

  // ── tiered: external HOLDS on each availability failure (No Silent Degradation) ─
  it("tiered: external + provider-error → HOLD (fail-closed)", async () => {
    const r = await new MessagingToneGate(providerError(), TIERED).review('status', { channel: 'telegram', recipientClass: 'external' });
    expect(r.pass).toBe(false);
    expect(r.failedClosed).toBe(true);
    expect(r.failedOpenOperatorChannel).toBeUndefined();
  });
  it("tiered: external + capacity-shed → HOLD (capacityUnavailable)", async () => {
    const r = await new MessagingToneGate(capacityShed(), TIERED).review('status', { channel: 'telegram', recipientClass: 'external' });
    expect(r.pass).toBe(false);
    expect(r.capacityUnavailable).toBe(true);
    expect(r.failedOpenOperatorChannel).toBeUndefined();
  });

  // ── ABSENT recipientClass defaults to external → HOLD (fail-closed) ─────────
  it("tiered: ABSENT recipientClass (ambiguity) → HOLD (defaults external/fail-closed)", async () => {
    const r = await new MessagingToneGate(providerError(), TIERED).review('status', { channel: 'telegram' });
    expect(r.pass).toBe(false);
    expect(r.failedOpenOperatorChannel).toBeUndefined();
  });

  // ── a real CONTENT BLOCK always holds, even operator + tiered ───────────────
  it("tiered: operator + real content BLOCK verdict → HOLD (a verdict is never tiered)", async () => {
    const r = await new MessagingToneGate(block(), TIERED).review('I updated .instar/config.json', { channel: 'telegram', recipientClass: 'operator' });
    expect(r.pass).toBe(false);
    expect(r.rule).toBe('B2_FILE_PATH');
    expect(r.failedOpenOperatorChannel).toBeUndefined();
  });
  it("tiered: operator + clean PASS verdict still passes normally (not a tier)", async () => {
    const r = await new MessagingToneGate(ok(), TIERED).review('hello', { channel: 'telegram', recipientClass: 'operator' });
    expect(r.pass).toBe(true);
    expect(r.failedOpenOperatorChannel).toBeUndefined(); // a genuine pass, not a fail-open deliver
  });

  // ── dryRun: operator availability failure is HELD, would-deliver logged ─────
  it("tiered + dryRun: operator + provider-error → still HELD (would-deliver only logged)", async () => {
    const r = await new MessagingToneGate(providerError(), { failClosedMode: 'tiered', toneTierDryRun: true }).review('status', { channel: 'telegram', recipientClass: 'operator' });
    expect(r.pass).toBe(false);
    expect(r.failedOpenOperatorChannel).toBeUndefined();
  });

  // ── back-compat: legacy 'never' (failClosedOnExhaustion:false) is unchanged ──
  it("legacy failClosedOnExhaustion:false (→'never') : operator + provider-error → legacy failedOpen, NOT operator-tier", async () => {
    const r = await new MessagingToneGate(providerError(), { failClosedOnExhaustion: false }).review('status', { channel: 'telegram', recipientClass: 'operator' });
    expect(r.pass).toBe(true);
    expect(r.failedOpen).toBe(true);
    expect(r.failedOpenOperatorChannel).toBeUndefined();
  });
  it("back-compat: failClosedOnExhaustion:true, no mode → 'always' → operator HOLDS", async () => {
    const r = await new MessagingToneGate(providerError(), { failClosedOnExhaustion: true }).review('status', { channel: 'telegram', recipientClass: 'operator' });
    expect(r.pass).toBe(false);
    expect(r.failedClosed).toBe(true);
  });
});
