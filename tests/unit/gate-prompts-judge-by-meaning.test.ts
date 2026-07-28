/**
 * Forward ratchet for the constitution standard
 * "Intelligent Prompts — An LLM Gate Must Not String-Match"
 * (spec: gate-prompts-judge-by-meaning-not-literal-lists §Design 7).
 *
 * This is REGRESSION DETECTION, not compliance PROOF. It catches the
 * necessary-literal-gate construction and light rewordings in a judgment-rule
 * prompt; an arbitrarily sophisticated semantic rewrite still needs human
 * review (the standard's honest limit). It makes NO runtime decision — it fails
 * CI to flag code for a human, so it is Signal-vs-Authority-compliant by
 * construction (a brittle filter flagging for the mind, never gating a runtime
 * call).
 *
 * It keys off the machine-readable RULE_CLASSES registry (NOT prose), so the
 * boundary between "literal-detection rules may match in-prompt" (B1–B7) and
 * "behavioral-judgment rules must judge by meaning" (B15–B18) is structural.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  RULE_CLASSES,
  VALID_RULES,
  PHASE2_MIGRATION_DEBT,
  DEFERRED_REFINEMENT,
  type GateRuleClass,
} from '../../src/core/MessagingToneGate.js';

const SRC = path.resolve(__dirname, '../../src/core/MessagingToneGate.ts');
const source = readFileSync(SRC, 'utf8');

/** The prose family that expresses "gate the block on a literal phrase from a list". */
const NECESSARY_LITERAL_GATE = [
  /block\s+only\s+if\s+the\s+message\s+contains\s+one\s+of\s+these\s+literal/i,
  /you\s+must\s+point\s+at\s+the\s+exact\s+string\s+when\s+applying/i,
  /contains\s+at\s+least\s+one\s+literal\s+[\w-]+\s+(?:pattern|phrase|marker)\s+from\s+the\s+list/i,
  /match\s+one\s+of\s+these\s+(?:phrases|markers|patterns)\s+(?:to|before)\s+(?:block|apply)/i,
  /apply\s+\w+\s+only\s+if\s+.{0,40}contains\s+.{0,40}literal/i,
];

/** Slice the prompt source into per-rule blocks keyed by the `**B##_NAME**` bullet markers. */
function ruleBlocks(): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\*\*(B\d+_[A-Z0-9_]+)\*\*/g;
  const marks: { id: string; idx: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) marks.push({ id: m[1], idx: m.index });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].idx : source.length;
    // Keep the LAST occurrence for an id (the rule definition, not a cross-reference).
    out[marks[i].id] = source.slice(marks[i].idx, end);
  }
  return out;
}

describe('gate-prompts-judge-by-meaning ratchet — An LLM Gate Must Not String-Match', () => {
  it('classifies EXACTLY the live VALID_RULES set (total classification, fail-closed)', () => {
    const classed = new Set(Object.keys(RULE_CLASSES));
    const valid = new Set(VALID_RULES);
    const unclassified = [...valid].filter((r) => !classed.has(r));
    const orphanClass = [...classed].filter((r) => !valid.has(r));
    expect(unclassified, `rules missing a class (would ship a judgment rule unclassified): ${unclassified}`).toEqual([]);
    expect(orphanClass, `RULE_CLASSES has ids not in VALID_RULES: ${orphanClass}`).toEqual([]);
    // B10 is intentionally reserved/absent.
    expect(valid.has('B10' as never)).toBe(false);
  });

  it('no behavioral / non-deterministic-detection rule prompt contains a necessary-literal-gate construction', () => {
    const blocks = ruleBlocks();
    const offenders: string[] = [];
    for (const [id, block] of Object.entries(blocks)) {
      const cls: GateRuleClass | undefined = RULE_CLASSES[id];
      if (!cls || cls === 'deterministic-detection') continue; // B1–B7 may literal-match (Phase-1 debt)
      if (NECESSARY_LITERAL_GATE.some((re) => re.test(block))) offenders.push(id);
    }
    expect(offenders, `judgment rules with a necessary-literal-gate construction: ${offenders}`).toEqual([]);
  });

  it('the shared block-rules header does NOT impose a necessary-literal-gate across all rules', () => {
    // The old global header ("block ONLY if the message contains one of these
    // LITERAL patterns") governed every rule. It must now be scoped to B1–B7.
    const headerArea = source.slice(0, source.indexOf('**B15_CONTEXT_DEATH_STOP**'));
    // The scoped B1–B7 header is allowed to mention literal matching for B1–B7,
    // but the BLANKET "block ONLY if ... LITERAL patterns" wording must be gone.
    expect(/##\s*BLOCK rules — block ONLY if the message contains one of these LITERAL/i.test(headerArea)).toBe(false);
  });

  it('B1–B7 are now SIGNAL-DRIVEN (CMT-1793 migration: detector emits a signal, prompt judges in context)', () => {
    // Post-CMT-1793: every B1–B7 rule is classed signal-driven and its prompt
    // block references the deterministic ARTIFACT-SIGNAL rather than instructing
    // the model to literal-scan the candidate itself.
    for (const r of ['B1_CLI_COMMAND', 'B2_FILE_PATH', 'B3_CONFIG_KEY', 'B4_COPY_PASTE_CODE', 'B5_API_ENDPOINT', 'B6_ENV_VAR', 'B7_CRON_OR_SLUG']) {
      expect(RULE_CLASSES[r], `${r} should be signal-driven after CMT-1793`).toBe('signal-driven');
    }
    const b1b7 = ruleBlocks();
    // Each block must reference its detector signal (the §Design 8 contract),
    // not instruct an in-prompt scan.
    expect(b1b7['B1_CLI_COMMAND']).toMatch(/signal is detected/i);
    expect(b1b7['B2_FILE_PATH']).toMatch(/signal is detected/i);
    // No B1–B7 rule may carry a necessary-literal-gate construction now that they
    // are scanned like every other judgment rule (covered by the scan test above);
    // here we positively assert the migration's signal-driven framing landed.
    const artifactHeader = source.slice(source.indexOf('## ARTIFACT rules (B1'), source.indexOf('## SIGNAL-DRIVEN'));
    expect(/SIGNAL-DRIVEN, judged in context/i.test(artifactHeader)).toBe(true);
    expect(/do NOT scan the candidate yourself/i.test(artifactHeader)).toBe(true);
  });

  it('B15 retains the ordered reason-gate (positive-presence — deleting the keystone fails CI)', () => {
    const b15 = ruleBlocks()['B15_CONTEXT_DEATH_STOP'] ?? '';
    expect(b15).toMatch(/EVALUATION ORDER/i);
    expect(b15).toMatch(/own operational state/i);
    expect(b15).toMatch(/JUDGE BY MEANING/i);
  });

  it('PHASE2_MIGRATION_DEBT is now EMPTY (CMT-1793 migration complete) — no rule still parked as in-prompt debt', () => {
    // The migration landed: B1–B7 are signal-driven, the allowlist is drained.
    // A non-empty allowlist now would mean a rule regressed to in-prompt debt.
    expect([...PHASE2_MIGRATION_DEBT.rules]).toEqual([]);
    // No rule may be classed 'deterministic-detection' anymore (the legacy class
    // is retired; a rule parked there would be unscanned literal-gate debt).
    for (const cls of Object.values(RULE_CLASSES)) expect(cls).not.toBe('deterministic-detection');
    expect(PHASE2_MIGRATION_DEBT.commitment).toMatch(/^CMT-\d+$/);
  });

  it('DEFERRED_REFINEMENT (the fail-open→fail-closed availability refinement) is bound to a non-placeholder commitment', () => {
    expect(DEFERRED_REFINEMENT.commitment).toMatch(/^CMT-\d+$/);
  });

  it('the ratchet itself catches a REWORDED necessary-literal-gate construction (negative test)', () => {
    const synthetic = `- **B15_CONTEXT_DEATH_STOP** — apply this ONLY if the candidate contains at least one literal context-death pattern from the list below.`;
    expect(NECESSARY_LITERAL_GATE.some((re) => re.test(synthetic))).toBe(true);
  });
});
