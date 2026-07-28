/**
 * Pins the MessagingToneGate prompt's rule-id output contract.
 *
 * INSTAR-Bench v2 finding (2026-07-02, A/B ab-tone-gate2 — 40 cells fixed /
 * 0 regressed across 7 routes): the prompt used to ENUMERATE SHORT rule ids
 * ("rule MUST be exactly one of B1–B9, B11, …") while parseResponse demands
 * the FULL identifier (e.g. B15_CONTEXT_DEATH_STOP) and fails closed on the
 * short form — the prompt instructed the exact output the parser rejects,
 * and every model through every door obeyed it. The same A/B round exposed a
 * second hazard: models quoting the candidate message with RAW double quotes
 * inside JSON strings, which breaks JSON.parse identically.
 *
 * This test pins both fixes at the source-text level so a future prompt edit
 * cannot silently reintroduce either failure class.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '../../src/core/MessagingToneGate.ts'), 'utf8');

describe('MessagingToneGate prompt rule-id contract', () => {
  it('demands the FULL rule identifier in the JSON schema line', () => {
    expect(src).toContain('the FULL rule identifier from the lists above');
    expect(src).toContain('never the bare number like B15');
  });

  it('does NOT enumerate short rule ids as the allowed values', () => {
    expect(src).not.toContain('rule MUST be exactly one of B1–B9');
  });

  it('carries the JSON quote-escaping rule for issue/suggestion strings', () => {
    expect(src).toContain('Escaping rule: when quoting the candidate inside issue/suggestion strings');
  });
});
