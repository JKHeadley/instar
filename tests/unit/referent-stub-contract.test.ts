/**
 * Prompt↔Parser contract — the topic-intent extractor's referent stub
 * (docs/specs/prompt-parser-contract-standard.md; context-budget §6.2, §15).
 *
 * With the context layers on, the extractor's existing per-message call
 * teaches a CLOSED `kind` vocabulary (answer | directive | question |
 * hypothetical | rejection | other) and the deterministic validator gates on
 * it. Single-source form: the prompt renders the vocabulary from
 * `REFERENT_STUB_KINDS` and the validator accepts exactly that set. This test
 * is the extractor's `contractTest` in src/data/llmBenchCoverage.ts.
 */
import { describe, it, expect } from 'vitest';
import { deriveRejectedForms, type PromptContract } from '../../src/core/promptContract.js';
import {
  REFERENT_STUB_KINDS, buildExtractorPrompt, parseExtractorAnalysis, type ExtractorInput,
} from '../../src/core/TopicIntentExtractor.js';
import { validateReferentStub } from '../../src/monitoring/contextLayers/userCorpus.js';

const input = {
  topicId: 1, arcId: 'arc-1',
  message: { id: '20', text: 'Block.', fromUser: true, turn: 1, at: '2026-11-10T10:00:00.000Z' },
  existingRefs: [],
  referentCandidates: [{ messageId: 10, text: 'Should the gate block or warn?' }],
} as unknown as ExtractorInput;

/** The REAL production path: parse the call's output, then validate the stub. */
function parseKind(kind: string): string | null {
  const raw = JSON.stringify({ signals: [], referentStub: { stub: '[answering: should the gate block or warn?]', kind, refersTo: '10' } });
  const a = parseExtractorAnalysis(raw, { referentStub: true });
  if (Array.isArray(a)) return null;
  const v = validateReferentStub(a.referentStub, { userText: 'Block.', userMessageId: 20, precedes: (id) => id === 10 });
  return v.ok ? v.stub.kind : null;
}

const contract: PromptContract<string | null> = {
  promisedOutputs: REFERENT_STUB_KINDS,
  rejectedForms: deriveRejectedForms(REFERENT_STUB_KINDS, ['', 'decision', 'settled', 'answer.', ' answer', 'answer|directive']),
  hazardPatterns: [/"kind":"decision"/],
  envelope: { shape: 'json', verdictField: 'referentStub.kind' },
  acceptedAliases: [],
  parser: parseKind,
};

describe('referent-stub prompt↔parser contract', () => {
  const prompt = buildExtractorPrompt(input);
  const full = `${prompt.systemPrompt}\n\n${prompt.userPrompt}`;

  it('the prompt teaches every promised kind, from the single source', () => {
    for (const k of contract.promisedOutputs) expect(full).toContain(`"${k}"`);
    expect(full).toContain('"referentStub"');
  });

  it('the real parser accepts every promised kind', () => {
    for (const k of contract.promisedOutputs) expect(contract.parser(k)).toBe(k);
  });

  it('the real parser rejects every derived and hand-picked non-promised form (fail-closed)', () => {
    expect(contract.rejectedForms.length).toBeGreaterThan(REFERENT_STUB_KINDS.length);
    for (const f of contract.rejectedForms) expect(contract.parser(f), `accepted non-promised kind "${f}"`).toBeNull();
  });

  it('no hazard shape appears in the rendered prompt', () => {
    for (const h of contract.hazardPatterns) expect(full).not.toMatch(h);
  });
});
