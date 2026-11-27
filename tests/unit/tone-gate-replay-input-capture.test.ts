/**
 * Replay input for the MessagingToneGate (benchmark Milestone 1, topic 33368).
 *
 * The tone-gate prompt is `renderToneGatePrompt(parts)`: a pure function of the
 * per-call dynamic parts (candidate, recent messages, signal sections, the random
 * boundary). With `toneGate.replayInput` on, the provenance context gains
 * content-free replay identity and the credential-scrubbed parts under the
 * machine-local CONTENT_FULL_KEY. The prompt rebuilt from the stored parts must
 * match `replayPromptSha256`, and equals the prompt the model saw exactly when
 * the scrub changed nothing. Off, the context carries none of it. Either way the
 * prompt and the verdict are unchanged.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  assessToneGateReplayEligibility,
  buildToneGateReplayCapture,
  MessagingToneGate,
  renderToneGatePrompt,
  scrubToneGatePromptParts,
  scrubToneGatePromptPartText,
  TONE_REPLAY_CAPTURE_VERSION,
  TONE_REPLAY_MAX_CAPTURE_BYTES,
  TONE_REPLAY_SCRUB_VERSION,
  type ToneGatePromptParts,
  type ToneReviewContext,
} from '../../src/core/MessagingToneGate.js';
import { buildStructuredSha256Identity, CONTENT_FULL_KEY, JudgmentProvenanceLog } from '../../src/core/JudgmentProvenanceLog.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PASS = JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' });
const BLOCK_B1 = JSON.stringify({
  pass: false,
  rule: 'B1_CLI_COMMAND',
  issue: 'CLI command handed to the user',
  suggestion: 'Run it yourself and report the result.',
});

const BODY_MARKER = 'ZT7_TONE_REPLAY_BODY_MARKER';
const TURN_MARKER = 'ZT7_TONE_REPLAY_TURN_MARKER';
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function capturingProvider(reply: string) {
  const seen: { prompt?: string; opts?: IntelligenceOptions; context?: Record<string, unknown> } = {};
  const provider: IntelligenceProvider = {
    async evaluate(prompt: string, opts?: IntelligenceOptions): Promise<string> {
      seen.prompt = prompt;
      seen.opts = opts;
      seen.context = (opts?.provenance as { context?: Record<string, unknown> } | undefined)?.context;
      return reply;
    },
  };
  return { provider, seen };
}

function reviewContext(turn = `the user asked about the release ${TURN_MARKER}`): ToneReviewContext {
  return {
    channel: 'telegram',
    messageKind: 'reply',
    recentMessages: [
      { role: 'user', text: turn },
      { role: 'agent', text: 'Checking now.' },
    ],
  };
}

const on = () => ({ replayInput: { enabled: true } });

describe('tone-gate replay capture (toneGate.replayInput)', () => {
  it('off: the context carries no replay identity and no stored parts', async () => {
    const { provider, seen } = capturingProvider(PASS);
    const gate = new MessagingToneGate(provider, {});
    await gate.review(`All done ${BODY_MARKER}`, reviewContext());
    const ctx = seen.context!;
    expect(ctx.captureVersion).toBeUndefined();
    expect(ctx.promptSha256).toBeUndefined();
    expect(ctx[CONTENT_FULL_KEY]).toBeUndefined();
    expect(JSON.stringify(ctx)).not.toContain(BODY_MARKER);
  });

  it('on: the stored parts rebuild the exact prompt the model saw (no secret, scrub changed nothing)', async () => {
    const { provider, seen } = capturingProvider(PASS);
    const gate = new MessagingToneGate(provider, on);
    await gate.review(`All done ${BODY_MARKER}`, reviewContext());
    const ctx = seen.context!;
    expect(ctx.captureVersion).toBe(TONE_REPLAY_CAPTURE_VERSION);
    expect(ctx.scrubVersion).toBe(TONE_REPLAY_SCRUB_VERSION);
    expect(ctx.scrubChanged).toBe(false);
    expect(ctx.promptSha256).toBe(buildStructuredSha256Identity(seen.prompt!));
    const parts = (ctx[CONTENT_FULL_KEY] as { replayParts: ToneGatePromptParts }).replayParts;
    expect(parts.candidateJson).toContain(BODY_MARKER);
    expect(parts.contextSection).toContain(TURN_MARKER);
    const rebuilt = renderToneGatePrompt(parts);
    expect(rebuilt).toBe(seen.prompt);
    const verdict = assessToneGateReplayEligibility(ctx);
    expect(verdict).toEqual({ eligible: true, prompt: seen.prompt, exact: true });
  });

  it('on: a credential in the candidate or a recent turn is scrubbed from the stored copy only', async () => {
    const { provider, seen } = capturingProvider(PASS);
    const gate = new MessagingToneGate(provider, on);
    await gate.review(`Token is ${SECRET} ${BODY_MARKER}`, reviewContext(`here is mine ${SECRET}`));
    expect(seen.prompt).toContain(SECRET); // the model still sees the original
    const ctx = seen.context!;
    expect(JSON.stringify(ctx)).not.toContain(SECRET);
    expect(ctx.scrubChanged).toBe(true);
    const verdict = assessToneGateReplayEligibility(ctx);
    expect(verdict.eligible).toBe(true);
    if (verdict.eligible) {
      expect(verdict.exact).toBe(false);
      expect(verdict.prompt).toContain(BODY_MARKER);
      expect(verdict.prompt).not.toContain(SECRET);
    }
  });

  it('on: secrets that JSON encoding hides from the patterns are still masked in what is stored', async () => {
    // Both are caught by scrubForStore as raw text and MISSED once JSON-encoded
    // (a quote becomes \" and a newline becomes \n), and both parts reach the
    // prompt encoded: the candidate as candidateJson, a recent message in contextSection.
    const LABELLED_VALUE = 'Zq81LmNopQrStUvWx';
    const labelledInJson = `here is my config: {"api_key": "${LABELLED_VALUE}"} ${BODY_MARKER}`;
    const PEM_BODY = 'MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA';
    const pem = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`;
    const { provider, seen } = capturingProvider(PASS);
    await new MessagingToneGate(provider, on).review(labelledInJson, reviewContext(`my key:\n${pem}`));
    expect(seen.prompt).toContain(LABELLED_VALUE); // the model still sees the original
    expect(seen.prompt).toContain(PEM_BODY);
    const stored = JSON.stringify(seen.context);
    expect(stored).not.toContain(LABELLED_VALUE);
    expect(stored).not.toContain(PEM_BODY);
    const parts = (seen.context![CONTENT_FULL_KEY] as { replayParts: ToneGatePromptParts }).replayParts;
    // The masked parts still render a prompt that passes the sha check, marked not exact.
    expect(() => JSON.parse(parts.candidateJson)).not.toThrow();
    const verdict = assessToneGateReplayEligibility(seen.context);
    expect(verdict.eligible).toBe(true);
    if (verdict.eligible) {
      expect(verdict.exact).toBe(false);
      expect(verdict.prompt).toContain(BODY_MARKER);
    }
  });

  it('scrubToneGatePromptPartText leaves a clean encoded part byte-identical', () => {
    const line = 'AGENT: "ok \\"quoted\\" text"\nUSER: "a\\nb"';
    expect(scrubToneGatePromptPartText(line)).toBe(line);
  });

  it('on: the candidate body capture and the replay parts share the machine-local key without colliding', async () => {
    const { provider, seen } = capturingProvider(PASS);
    const gate = new MessagingToneGate(provider, () => ({ recordCandidateBody: true, replayInput: { enabled: true } }));
    await gate.review(`All done ${BODY_MARKER}`, reviewContext());
    const full = seen.context![CONTENT_FULL_KEY] as Record<string, unknown>;
    expect(full.candidateBody).toContain(BODY_MARKER);
    expect((full.replayParts as ToneGatePromptParts).candidateJson).toContain(BODY_MARKER);
  });

  it('the verdict is identical with the capture on and off (PASS and BLOCK)', async () => {
    for (const reply of [PASS, BLOCK_B1]) {
      const a = capturingProvider(reply);
      const b = capturingProvider(reply);
      const offResult = await new MessagingToneGate(a.provider, {}).review('run: `npm install`', reviewContext());
      const onResult = await new MessagingToneGate(b.provider, on).review('run: `npm install`', reviewContext());
      expect(onResult.pass).toBe(offResult.pass);
      expect(onResult.rule).toBe(offResult.rule);
      expect(onResult.issue).toBe(offResult.issue);
    }
  });

  it('the prompt text is unchanged by the switch apart from the per-call boundary', async () => {
    const a = capturingProvider(PASS);
    const b = capturingProvider(PASS);
    await new MessagingToneGate(a.provider, {}).review(`All done ${BODY_MARKER}`, reviewContext());
    await new MessagingToneGate(b.provider, on).review(`All done ${BODY_MARKER}`, reviewContext());
    // Every per-call boundary is random; everything else must match byte for byte.
    const strip = (p: string) => p.replace(/\b([A-Z_]+_BOUNDARY|ASK_LINKS)_[0-9a-f]{16}/g, '$1_X');
    expect(strip(b.prompt!)).toBe(strip(a.prompt!));
  });
});

describe('assessToneGateReplayEligibility refuses what it cannot prove', () => {
  const parts: ToneGatePromptParts = {
    channel: 'telegram',
    kindSection: '\n=== MESSAGE KIND ===\nreply\n',
    contextSection: '',
    signalsSection: '\n=== UPSTREAM SIGNALS ===\n(no signals reported)\n',
    gateSignalsSection: '',
    styleSection: '',
    agentStateSection: '',
    standingAuthSection: '',
    agentReachSection: '',
    boundary: 'MSG_BOUNDARY_0123456789abcdef',
    candidateJson: JSON.stringify(`hello ${BODY_MARKER}`),
  };
  const good = () => buildToneGateReplayCapture(parts, renderToneGatePrompt(parts));

  it('accepts a sound capture as exact', () => {
    const v = assessToneGateReplayEligibility(good());
    expect(v.eligible).toBe(true);
    if (v.eligible) expect(v.exact).toBe(true);
  });

  it('refuses a truncated row, a missing capture, an unknown version, a malformed capture and a tampered part', () => {
    expect(assessToneGateReplayEligibility(good(), { rowTruncated: true })).toEqual({ eligible: false, reason: 'row-truncated' });
    expect(assessToneGateReplayEligibility({ truncated: true, head: '{}' })).toEqual({ eligible: false, reason: 'row-truncated' });
    expect(assessToneGateReplayEligibility({ candidate: { sha256: 'x' } })).toEqual({ eligible: false, reason: 'no-capture' });
    expect(assessToneGateReplayEligibility(null)).toEqual({ eligible: false, reason: 'no-capture' });
    expect(assessToneGateReplayEligibility({ ...good(), captureVersion: 'tone-replay-input-v0' }))
      .toEqual({ eligible: false, reason: 'unknown-capture-version' });
    expect(assessToneGateReplayEligibility({ captureVersion: 'capture-failed' }))
      .toEqual({ eligible: false, reason: 'unknown-capture-version' });
    const stored = (c: Record<string, unknown>) => (c[CONTENT_FULL_KEY] as { replayParts: Record<string, unknown> }).replayParts;
    const missingPart = good();
    delete stored(missingPart).boundary;
    expect(assessToneGateReplayEligibility(missingPart)).toEqual({ eligible: false, reason: 'malformed-capture' });
    const noShas = good();
    delete noShas.replayPromptSha256;
    expect(assessToneGateReplayEligibility(noShas)).toEqual({ eligible: false, reason: 'malformed-capture' });
    const tampered = good();
    stored(tampered).candidateJson = JSON.stringify('something else');
    expect(assessToneGateReplayEligibility(tampered)).toEqual({ eligible: false, reason: 'sha-mismatch' });
  });

  it('a part the scrubber withheld wholesale is not replayable', () => {
    for (const marker of ['[REDACTED:oversize] (2000000 chars withheld)', '[REDACTED:scrub-error]']) {
      const withheld = { ...parts, contextSection: marker };
      expect(assessToneGateReplayEligibility(buildToneGateReplayCapture(withheld, renderToneGatePrompt(withheld))))
        .toEqual({ eligible: false, reason: 'part-withheld' });
      const encoded = { ...parts, candidateJson: JSON.stringify(marker) };
      expect(assessToneGateReplayEligibility(buildToneGateReplayCapture(encoded, renderToneGatePrompt(encoded))))
        .toEqual({ eligible: false, reason: 'part-withheld' });
    }
  });

  it('an oversize capture is skipped and labelled, so the row stays whole', () => {
    const big = { ...parts, candidateJson: JSON.stringify('x'.repeat(TONE_REPLAY_MAX_CAPTURE_BYTES + 1)) };
    const capture = buildToneGateReplayCapture(big, renderToneGatePrompt(big));
    expect(capture.captureVersion).toBe('capture-oversize');
    expect(capture[CONTENT_FULL_KEY]).toBeUndefined();
    expect(JSON.stringify(capture).length).toBeLessThan(500);
    expect(assessToneGateReplayEligibility(capture)).toEqual({ eligible: false, reason: 'capture-oversize' });
  });

  it('the bound is in stored bytes: multi-byte text under the byte count in characters is still oversize', () => {
    // 25,000 three-byte characters: fewer characters than the bound, about 75,000 bytes stored.
    const wide = { ...parts, candidateJson: JSON.stringify('界'.repeat(25_000)) };
    expect(wide.candidateJson.length).toBeLessThan(TONE_REPLAY_MAX_CAPTURE_BYTES);
    expect(buildToneGateReplayCapture(wide, renderToneGatePrompt(wide)).captureVersion).toBe('capture-oversize');
  });

  it('a heavily escaped capture under the bound is stored whole, its escaping counted', () => {
    const quoted = { ...parts, candidateJson: JSON.stringify('say "hi" \\ '.repeat(1_500)) };
    const capture = buildToneGateReplayCapture(quoted, renderToneGatePrompt(quoted));
    expect(capture.captureVersion).toBe(TONE_REPLAY_CAPTURE_VERSION);
    expect(Buffer.byteLength(JSON.stringify(capture), 'utf8')).toBeLessThan(64 * 1024 - 19 * 1024);
  });

  it('scrubToneGatePromptParts keeps every part a string, even an absent optional one', () => {
    const { agentReachSection: _omit, ...withoutReach } = parts;
    const scrubbed = scrubToneGatePromptParts(withoutReach as ToneGatePromptParts);
    expect(scrubbed.agentReachSection).toBe('');
    expect(renderToneGatePrompt(scrubbed)).toBe(renderToneGatePrompt(parts));
  });
});

describe('the stored parts never leave the machine-local field', () => {
  it('GET-style redacted reads omit the parts; the full local read keeps them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tone-replay-prov-'));
    try {
      const { provider, seen } = capturingProvider(PASS);
      await new MessagingToneGate(provider, on).review(`All done ${BODY_MARKER}`, reviewContext());
      const log = new JudgmentProvenanceLog({ dir, log: () => {} });
      try {
        await log.recordDecisionFlushed({
          component: 'MessagingToneGate',
          decisionPoint: 'messaging-tone-gate',
          context: seen.context!,
          optionsPresented: ['PASS', 'BLOCK'],
          decision: 'PASS',
          reason: 'test',
          floor: 'test',
          fallbackRung: 'llm',
        });
        const redacted = JSON.stringify(await log.readRedacted({ limit: 10 }));
        expect(redacted).toContain(TONE_REPLAY_CAPTURE_VERSION);
        expect(redacted).not.toContain(BODY_MARKER);
        expect(redacted).not.toContain(TURN_MARKER);
        expect(redacted).not.toContain('replayParts');
        // The machine-local file keeps the parts, and they pass the sha check.
        const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
        const row = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').pop()!);
        expect(assessToneGateReplayEligibility(row.contextFull).eligible).toBe(true);
      } finally {
        await log.close();
      }
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/tone-gate-replay-input-capture.test.ts:cleanup' });
    }
  });
});
