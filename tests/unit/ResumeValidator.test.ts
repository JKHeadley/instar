/**
 * ResumeValidator — LLM-supervised coherence gate for session resume.
 *
 * Tests the coherence check that validates a session's content matches
 * a topic's conversation history before resuming.
 *
 * CRITICAL REQUIREMENT: Instar NEVER requires external API keys for
 * functionality that can be handled by Claude Code models. The ResumeValidator
 * uses IntelligenceProvider (Claude CLI) — no GOOGLE_GENERATIVE_AI_API_KEY,
 * no ANTHROPIC_API_KEY, no external dependencies.
 */

import { boundedTail } from '../../src/core/boundedInput.js';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  llmValidateResumeCoherence,
  RESUME_UUID_VALIDATE_PROMPT_ID,
  COHERENCE_CONTEXT_MAX_CHARS,
} from '../../src/core/ResumeValidator.js';
import { DP_RESUME_UUID_VALIDATE } from '../../src/data/provenanceCoverage.js';

// ─── Test Fixtures ──────────────────────────────────────────────────────

const INTERACTIVE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TOPIC_ID = 9154;

const topicHistory = async () => ({
  topicName: 'test-topic',
  messages: [
    { sender: 'User', text: 'Can you help debug the login issue?' },
    { sender: 'Agent', text: 'Looking into the authentication flow now.' },
  ],
});

const matchingSession = () =>
  'Session content samples:\n  Debugging authentication flow. Found issue in login handler.';

const mismatchingSession = () =>
  'Session content samples:\n  Posted 5 messages on AICQ about consciousness topics.';

// ─── No External API Keys Required ─────────────────────────────────────

describe('ResumeValidator: No External API Keys Required', () => {
  it('does NOT import or reference GOOGLE_GENERATIVE_AI_API_KEY', () => {
    const source = fs.readFileSync(
      new URL('../../src/core/ResumeValidator.ts', import.meta.url),
      'utf-8',
    );
    expect(source).not.toContain('GOOGLE_GENERATIVE_AI_API_KEY');
  });

  it('does NOT import or reference ANTHROPIC_API_KEY', () => {
    const source = fs.readFileSync(
      new URL('../../src/core/ResumeValidator.ts', import.meta.url),
      'utf-8',
    );
    expect(source).not.toContain('ANTHROPIC_API_KEY');
  });

  it('does NOT make direct HTTP calls to external AI APIs', () => {
    const source = fs.readFileSync(
      new URL('../../src/core/ResumeValidator.ts', import.meta.url),
      'utf-8',
    );
    expect(source).not.toContain('generativelanguage.googleapis.com');
    expect(source).not.toContain('api.anthropic.com');
    expect(source).not.toContain('openai.com');
  });

  it('uses IntelligenceProvider interface (Claude CLI compatible)', () => {
    const source = fs.readFileSync(
      new URL('../../src/core/ResumeValidator.ts', import.meta.url),
      'utf-8',
    );
    expect(source).toContain('IntelligenceProvider');
    expect(source).toContain("import type { IntelligenceProvider }");
  });

  it('fails safe when no IntelligenceProvider is available', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project',
      null, // no telegram
      null, // no intelligence provider
      // no evaluateFn either
    );
    expect(result).toBe(false);
  });
});

// ─── LLM Coherence Gate Tests ───────────────────────────────────────────

describe('ResumeValidator: LLM Coherence Gate', () => {
  it('returns true when LLM says MATCH', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => 'MATCH',
      },
    );
    expect(result).toBe(true);
  });

  it('returns false when LLM says MISMATCH', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: mismatchingSession,
        evaluateFn: async () => 'MISMATCH',
      },
    );
    expect(result).toBe(false);
  });

  it('fails safe on LLM error', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => { throw new Error('Claude CLI timeout'); },
      },
    );
    expect(result).toBe(false);
  });

  it('fails safe on empty LLM response', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => '',
      },
    );
    expect(result).toBe(false);
  });

  it('fails safe on ambiguous response (neither MATCH nor MISMATCH)', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => 'UNCLEAR - need more context',
      },
    );
    expect(result).toBe(false);
  });

  it('fails safe when response contains both MATCH and MISMATCH', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => 'It could be a MATCH or a MISMATCH',
      },
    );
    expect(result).toBe(false);
  });

  it('handles case-insensitive MATCH response', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => 'match',
      },
    );
    expect(result).toBe(true);
  });

  it('handles MATCH with trailing whitespace/newlines', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => 'MATCH\n',
      },
    );
    expect(result).toBe(true);
  });

  it('passes correct prompt to evaluator', async () => {
    let capturedPrompt = '';
    await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
        evaluateFn: async (prompt: string) => { capturedPrompt = prompt; return 'MATCH'; },
      },
    );

    expect(capturedPrompt).toContain('test-topic');
    expect(capturedPrompt).toContain('MATCH or MISMATCH');
    expect(capturedPrompt).toContain('login issue');
    expect(capturedPrompt).toContain('authentication flow');
  });

  it('uses TelegramAdapter when deps.getTopicHistory not provided', async () => {
    let capturedPrompt = '';
    const mockTelegram = {
      searchLog: (opts: { topicId: number; limit: number }) => [
        { text: 'Hello from Telegram', fromUser: true },
        { text: 'Hello back', fromJustin: false, fromUser: false },
      ],
      getTopicName: () => 'telegram-topic',
    };

    await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', mockTelegram, null,
      {
        readSessionJsonl: matchingSession,
        evaluateFn: async (prompt: string) => { capturedPrompt = prompt; return 'MATCH'; },
      },
    );

    expect(capturedPrompt).toContain('Hello from Telegram');
    expect(capturedPrompt).toContain('User:');
  });

  it('handles topic history fetch failure gracefully', async () => {
    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: (async () => { throw new Error('JSONL read failed'); }) as any,
        readSessionJsonl: matchingSession,
        evaluateFn: async () => 'MISMATCH',
      },
    );
    expect(result).toBe(false);
  });

  // ── *Never Silently Cut the Data a Decision Depends On* ──────────────────────────────────────

  it('bounds very long content — the prompt cannot grow without limit', async () => {
    let capturedPrompt = '';
    const longText = 'x'.repeat(500_000);

    await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: async () => ({
          topicName: 'test-topic',
          messages: [{ sender: 'User', text: longText }],
        }),
        readSessionJsonl: () => longText,
        evaluateFn: async (prompt: string) => { capturedPrompt = prompt; return 'MATCH'; },
      },
    );

    // Two bounded blocks plus the fixed template — not half a megabyte.
    expect(capturedPrompt.length).toBeLessThan(COHERENCE_CONTEXT_MAX_CHARS * 2 + 4000);
  });

  it('keeps the NEWEST topic messages, not the oldest — the evidence, not the preamble', async () => {
    // The earned failure: `topicHistory` is assembled oldest-first, so the old
    // `.slice(0, 1500)` discarded the most recent messages — exactly what says
    // what the conversation is now about, and exactly what this gate compares.
    let capturedPrompt = '';
    const filler = Array.from({ length: 10 }, (_, i) => ({
      sender: 'User',
      text: `FILLER-${i} ` + 'y'.repeat(600),
    }));

    await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null, null,
      {
        getTopicHistory: async () => ({
          topicName: 'test-topic',
          messages: [
            { sender: 'User', text: 'OLDEST-MESSAGE-MARKER' },
            ...filler,
            { sender: 'User', text: 'NEWEST-MESSAGE-MARKER' },
          ],
        }),
        readSessionJsonl: () => 'session body',
        evaluateFn: async (prompt: string) => { capturedPrompt = prompt; return 'MATCH'; },
      },
    );

    expect(capturedPrompt).toContain('NEWEST-MESSAGE-MARKER');
    expect(capturedPrompt).not.toContain('OLDEST-MESSAGE-MARKER');
  });

  it('DISCLOSES the cut to the model that is about to judge — its fail-safe is MISMATCH', () => {
    // A silent cut biases this gate toward declaring a legitimate resume
    // incoherent, and the model had no way to know it was reading a fragment.
    const cut = boundedTail('z'.repeat(200_000), COHERENCE_CONTEXT_MAX_CHARS);
    expect(cut).toContain('BOUNDED INPUT');
    expect(cut).toContain('EARLIER content was omitted');
  });

  it('does NOT disclose on the ordinary case — the bound is above what the caller emits', () => {
    // Ten messages, each already clamped to 200 chars, plus prefixes: the
    // derivation behind COHERENCE_CONTEXT_MAX_CHARS. A marker here would be
    // routine noise and would stop meaning anything.
    const ordinary = Array.from({ length: 10 }, (_, i) => `  User: ${'m'.repeat(200)}${i}`).join('\n');
    expect(boundedTail(ordinary, COHERENCE_CONTEXT_MAX_CHARS)).toBe(ordinary);
  });

  it('uses IntelligenceProvider.evaluate when evaluateFn not provided', async () => {
    let evaluateCalled = false;
    let capturedPrompt = '';
    let capturedOptions: any;
    const mockIntelligence = {
      evaluate: async (prompt: string, options?: any) => {
        evaluateCalled = true;
        capturedPrompt = prompt;
        capturedOptions = options;
        expect(options?.model).toBe('fast');
        return 'MATCH';
      },
    };

    const result = await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null,
      mockIntelligence,
      {
        getTopicHistory: async () => ({
          topicName: 'test-topic',
          messages: [{ sender: 'User', text: 'cobalt-lantern private topic context' }],
        }),
        readSessionJsonl: () => 'cobalt-lantern private session context',
      },
    );

    expect(evaluateCalled).toBe(true);
    expect(result).toBe(true);
    expect(capturedPrompt).toContain('cobalt-lantern');
    expect(capturedOptions.provenance).toMatchObject({
      decisionPoint: DP_RESUME_UUID_VALIDATE,
      optionsPresented: ['match', 'mismatch'],
      promptId: RESUME_UUID_VALIDATE_PROMPT_ID,
    });
    expect(JSON.stringify(capturedOptions.provenance.context)).not.toContain('cobalt-lantern');
  });

  it('uses "fast" model tier for lightweight evaluation', async () => {
    let modelUsed = '';
    const mockIntelligence = {
      evaluate: async (_prompt: string, options?: any) => {
        modelUsed = options?.model ?? '';
        return 'MATCH';
      },
    };

    await llmValidateResumeCoherence(
      INTERACTIVE_UUID, TOPIC_ID, 'test-topic', '/tmp/test-project', null,
      mockIntelligence,
      {
        getTopicHistory: topicHistory,
        readSessionJsonl: matchingSession,
      },
    );

    expect(modelUsed).toBe('fast');
  });
});
