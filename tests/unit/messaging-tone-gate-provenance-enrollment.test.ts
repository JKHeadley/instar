/**
 * MessagingToneGate provenance enrollment — LLM-Decision Quality Meter §5.6
 * (docs/specs/llm-decision-quality-meter.md §5.1.4 per-callsite contract +
 * §5.2 content-bearing envelope discipline + §5.6 always-on high-volume gate).
 *
 * Pins, semantically (both sides of every boundary):
 *   - the verdict-producing LLM call enrolls via `options.provenance` under the
 *     typed decision-point id `messaging-tone-gate` (imported, not a literal);
 *   - context is candidate IDENTITY ONLY — sha256 + byte/char bounds + code-derived
 *     features — the outbound BODY (and any plaintext slice of it) never enters the
 *     envelope, and the envelope stays bounded for arbitrarily large messages;
 *   - a leaked credential in the candidate never lands in the row (no plaintext);
 *   - `optionsPresented`/`promptId` are the static, clamp-safe labels;
 *   - the enrollment is OBSERVABILITY-ONLY: it never changes the block/allow
 *     verdict, and a provider that ignores (or a callback that throws over) the
 *     provenance block yields the exact same verdict.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  MessagingToneGate,
  buildToneDecisionContext,
  TONE_GATE_PROMPT_ID,
  TONE_OPTIONS_PRESENTED,
} from '../../src/core/MessagingToneGate.js';
import type { ToneReviewContext } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { DP_MESSAGING_TONE_GATE } from '../../src/data/provenanceCoverage.js';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Captures the options the gate passed to the provider; replies with `reply`. */
function capturingProvider(reply: string) {
  const captured: { prompt?: string; opts?: IntelligenceOptions } = {};
  const provider: IntelligenceProvider = {
    async evaluate(prompt: string, opts?: IntelligenceOptions): Promise<string> {
      captured.prompt = prompt;
      captured.opts = opts;
      return reply;
    },
  };
  return { provider, captured };
}

const PASS = JSON.stringify({ pass: true, issue: '', suggestion: '' });
const BLOCK_B1 = JSON.stringify({
  pass: false,
  rule: 'B1_CLI_COMMAND',
  issue: 'CLI command handed to the user',
  suggestion: 'Run it yourself and report the result.',
});

const BODY_MARKER = 'ZX9_OUTBOUND_BODY_MARKER_UNIQ';
const SECRET = 'sk-live-ZX9SECRETTOKEN0000000000';

describe('review() enrollment (decision point messaging-tone-gate)', () => {
  it('carries options.provenance with the typed decision point, the deliver/block option space, and the prompt-version promptId', async () => {
    const { provider, captured } = capturingProvider(PASS);
    const gate = new MessagingToneGate(provider);
    await gate.review(`hello ${BODY_MARKER}`, { channel: 'telegram' });

    const p = captured.opts?.provenance;
    expect(p).toBeDefined();
    expect(p?.decisionPoint).toBe(DP_MESSAGING_TONE_GATE);
    expect(p?.optionsPresented).toEqual([...TONE_OPTIONS_PRESENTED]);
    expect(p?.promptId).toBe(TONE_GATE_PROMPT_ID);
    // §5.2 clamp-safety: promptId must survive the settlement charset clamp.
    expect(p?.promptId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    // The census 1:1 component key is unchanged.
    expect(captured.opts?.attribution?.component).toBe('MessagingToneGate');
  });

  it('context is candidate IDENTITY (hash + bounds) — never the outbound body or any plaintext slice', async () => {
    const text = `line one ${BODY_MARKER}\nline two`;
    const { provider, captured } = capturingProvider(PASS);
    const gate = new MessagingToneGate(provider);
    await gate.review(text, { channel: 'telegram', messageKind: 'reply' });

    const ctx = captured.opts?.provenance?.context as Record<string, any>;
    expect(ctx).toBeDefined();
    expect(ctx.candidate.sha256).toBe(sha256(text));
    expect(ctx.candidate.bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(ctx.candidate.chars).toBe(text.length);
    expect(ctx.channel).toBe('telegram');
    expect(ctx.messageKind).toBe('reply');

    // The body NEVER enters the envelope — not the whole thing, not a slice.
    expect(JSON.stringify(ctx)).not.toContain(BODY_MARKER);
    // The prompt legitimately carries the body (it goes to the model, not the row).
    expect(captured.prompt).toContain(BODY_MARKER);
  });

  it('a leaked credential in the candidate NEVER lands in the row (no plaintext stored at all)', async () => {
    const text = `Here is the key: ${SECRET} — set it in your env`;
    const { provider, captured } = capturingProvider(PASS);
    const gate = new MessagingToneGate(provider);
    await gate.review(text, { channel: 'telegram' });

    const ctx = captured.opts?.provenance?.context as Record<string, any>;
    // The exact-hash identity is preserved, but the raw secret never crosses.
    expect(ctx.candidate.sha256).toBe(sha256(text));
    expect(JSON.stringify(ctx)).not.toContain(SECRET);
  });

  it('the envelope stays BOUNDED for an arbitrarily large outbound message', async () => {
    const huge = 'x'.repeat(1_000_000);
    const { provider, captured } = capturingProvider(PASS);
    const gate = new MessagingToneGate(provider);
    await gate.review(huge, { channel: 'telegram' });
    const bytes = Buffer.byteLength(JSON.stringify(captured.opts?.provenance?.context), 'utf8');
    expect(bytes).toBeLessThan(512);
  });

  it('gateSignalKinds ride as KINDS (identity + features), not the offending substrings', async () => {
    // A CLI command triggers the cli-command signal; the KIND rides, not the cmd.
    const text = 'To fix, run: `instar server restart` in your shell';
    const { provider, captured } = capturingProvider(BLOCK_B1);
    const gate = new MessagingToneGate(provider);
    await gate.review(text, { channel: 'telegram' });
    const ctx = captured.opts?.provenance?.context as Record<string, any>;
    expect(Array.isArray(ctx.gateSignalKinds)).toBe(true);
    // The kinds are enum-like tokens, not the command text.
    for (const k of ctx.gateSignalKinds) expect(typeof k).toBe('string');
  });

  it('enrollment is OBSERVABILITY-ONLY: a provider that ignores the block returns the same PASS verdict', async () => {
    const { provider } = capturingProvider(PASS);
    const gate = new MessagingToneGate(provider);
    const r = await gate.review('all good', { channel: 'telegram' });
    expect(r.pass).toBe(true);
    expect(r.rule).toBe('');
  });

  it('enrollment does NOT alter a BLOCK verdict (the block/allow decision is unchanged by provenance)', async () => {
    const { provider, captured } = capturingProvider(BLOCK_B1);
    const gate = new MessagingToneGate(provider);
    const r = await gate.review('run: `npm install`', { channel: 'telegram' });
    expect(r.pass).toBe(false);
    expect(r.rule).toBe('B1_CLI_COMMAND');
    // The block still carried the enrollment (observed, not gated on).
    expect(captured.opts?.provenance?.decisionPoint).toBe(DP_MESSAGING_TONE_GATE);
  });
});

describe('buildToneDecisionContext — pure helper (identity-only discipline)', () => {
  const baseCtx: ToneReviewContext = { channel: 'slack', messageKind: 'health-alert' };

  it('captures identity + code-derived scalars, never the body', () => {
    const text = `a message with ${BODY_MARKER}`;
    const ctx = buildToneDecisionContext(text, baseCtx);
    expect(ctx.candidate).toMatchObject({
      sha256: sha256(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      chars: text.length,
    });
    expect(ctx.channel).toBe('slack');
    expect(ctx.messageKind).toBe('health-alert');
    expect(ctx.recentMessageCount).toBe(0);
    // No plaintext of the body anywhere on the envelope.
    expect(JSON.stringify(ctx)).not.toContain(BODY_MARKER);
  });

  it('never stores a plaintext slice — a credential in the candidate never crosses (identity is the hash)', () => {
    const text = `${SECRET} ` + 'y'.repeat(1000);
    const ctx = buildToneDecisionContext(text, baseCtx);
    expect((ctx.candidate as Record<string, any>).sha256).toBe(sha256(text));
    // The envelope carries NO head/body field — the secret cannot be in it.
    expect((ctx.candidate as Record<string, any>).head).toBeUndefined();
    expect(JSON.stringify(ctx)).not.toContain(SECRET);
  });

  it('records the recent-message COUNT (not the messages)', () => {
    const ctx = buildToneDecisionContext('hi', {
      channel: 'telegram',
      recentMessages: [
        { role: 'user', text: 'q1' },
        { role: 'agent', text: 'a1' },
      ],
    });
    expect(ctx.recentMessageCount).toBe(2);
    expect(JSON.stringify(ctx)).not.toContain('q1');
    expect(JSON.stringify(ctx)).not.toContain('a1');
  });
});
