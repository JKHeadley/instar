import { describe, it, expect } from 'vitest';
import { buildToneDecisionContext } from '../../src/core/MessagingToneGate.js';
import type { ToneReviewContext } from '../../src/core/MessagingToneGate.js';

// Minimal context — every field buildToneDecisionContext reads is optional (?? defaults).
const CTX = {} as ToneReviewContext;

describe('buildToneDecisionContext — observe-only deferral signal', () => {
  it('records deferralShapeDetected=true for a premature-deferral message', () => {
    const ctx = buildToneDecisionContext(
      'You start Codey on the laptop, or set me up with access and I will do it.',
      CTX,
    );
    expect(ctx.deferralShapeDetected).toBe(true);
  });

  it('records deferralShapeDetected=false for a genuine decision question', () => {
    const ctx = buildToneDecisionContext(
      'Which promotion model do you want — auto-climb or per-step operator-trigger?',
      CTX,
    );
    expect(ctx.deferralShapeDetected).toBe(false);
  });

  it('records deferralShapeDetected=false for the agent reporting its own action', () => {
    const ctx = buildToneDecisionContext('I restarted the service and it is healthy now.', CTX);
    expect(ctx.deferralShapeDetected).toBe(false);
  });

  it('is CONTENT-FREE: the signal is a plain boolean, never the message text', () => {
    const text = 'Can you restart Codey for me?';
    const ctx = buildToneDecisionContext(text, CTX);
    expect(typeof ctx.deferralShapeDetected).toBe('boolean');
    // The whole context must never embed the raw message body (identity-only discipline).
    expect(JSON.stringify(ctx)).not.toContain(text);
  });

  it('is PURELY ADDITIVE: the existing content-free fields are untouched', () => {
    const ctx = buildToneDecisionContext('hello there', CTX);
    // Pre-existing identity fields still present + unchanged in shape.
    expect((ctx.candidate as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(ctx.gateSignalKinds)).toBe(true);
    expect(ctx.messageKind).toBe('reply');
    // And the new field rides alongside them.
    expect(ctx).toHaveProperty('deferralShapeDetected');
  });

  it('fails open: an empty candidate never throws and records false', () => {
    const ctx = buildToneDecisionContext('', CTX);
    expect(ctx.deferralShapeDetected).toBe(false);
  });
});
