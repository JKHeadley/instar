/**
 * Shared prompt↔parser contract library — the mechanical arm of the
 * "The Prompt and the Parser Are One Contract" standard (defect class 1 closure;
 * docs/specs/prompt-parser-contract-standard.md).
 *
 * WHY THIS EXISTS (earned): on 2026-07-02 the INSTAR-Bench v2 defect-class
 * review found the tone gate's PROMPT taught models the short rule id ("B15")
 * while its production PARSER accepts only the full identifier
 * ("B15_CONTEXT_DEATH_STOP") and fails closed on the short form. Every model
 * through every door obeyed the prompt and "failed" — a 100%-our-fault defect.
 * An LLM callsite whose output is machine-parsed is ONE contract with TWO halves
 * maintained separately: the prompt promises an output vocabulary/shape; the
 * parser accepts one. Nothing held them coherent. This module gives that
 * contract a code artifact — the type of a co-located promise, and a pure
 * generator for the counter-examples a contract test must prove the parser
 * REJECTS — so a taught-but-unparsed vocabulary becomes a CI failure instead of
 * a latent door.
 *
 * SCOPE HONESTY (design §2): the PREFERRED form for an enumerated-verdict
 * callsite is single-sourcing — prompt, parser, and test all consume ONE
 * exported verdict constant, which makes a taught-but-undeclared token
 * structurally impossible. The `PromptContract` manifest below is the FALLBACK
 * form for prose-shaped prompts where single-sourcing is impractical (a reviewed
 * claim per spec §2, not an author's private call). This module ships DARK: it
 * introduces no runtime caller and changes NO live prompt or parser behavior.
 * It is consumed only by the per-callsite CONTRACT TESTS that graduate on the
 * shrink-only schedule (rollout §1/§2) — each of which renders the REAL
 * production prompt through an exported pure render function; that render
 * refactor of the live builders is deferred to its own A/B-gated increments and
 * is NOT part of this dark increment.
 */

/**
 * The election of a contract's form, recorded per coverage entry (spec §2:
 * "Form election is not self-certified"). A `manifest`-form entry on an
 * enumerated-verdict callsite requires an X1 argued reason in the registry.
 */
export type ContractForm = 'single-source' | 'manifest';

/**
 * The co-located machine-readable promise for a prose-shaped (fallback-form)
 * callsite. Co-location is the point (spec §2): a prompt edit lands in the same
 * file/diff as the promise, so review and CI see contract drift as ONE change.
 *
 * The `parser` is a FUNCTION REFERENCE, never a string — refactor-safe (spec §2).
 * A parser returning a non-null/defined value for an input is treated as
 * "accepted"; the contract test decides acceptance semantics per callsite.
 */
export interface PromptContract<TAccepted = unknown> {
  /**
   * Every terminal token/shape the prompt text tells the model to produce.
   * Prefer the shared verdict constant even here (spec §2).
   */
  readonly promisedOutputs: readonly string[];
  /**
   * Canonical counter-examples the parser must REJECT (fail-closed proof).
   * MECHANICALLY DERIVED from `promisedOutputs` via `deriveRejectedForms`
   * (case-mutation, prefix-truncation, separator-stripping) plus hand-picked
   * extras — a hand-only list invites trivial rejects (spec §2).
   */
  readonly rejectedForms: readonly string[];
  /**
   * Known-hazard shapes that must NOT appear anywhere in the full rendered
   * prompt outside explicitly-declared negative sections (spec §3.1) — the
   * inverse-direction backstop (e.g. bare rule ids the parser rejects).
   */
  readonly hazardPatterns: readonly RegExp[];
  /**
   * The response envelope the prompt promises (JSON shape, field names).
   */
  readonly envelope: { readonly shape: 'json' | 'text'; readonly verdictField?: string };
  /**
   * Compatibility forms the parser DELIBERATELY accepts (documented, tested).
   * "non-promised" for the fail-closed test means outside promised ∪ aliases.
   */
  readonly acceptedAliases: readonly string[];
  /** The REAL production parser, by reference. */
  readonly parser: (raw: string) => TAccepted;
}

/**
 * Options for {@link deriveRejectedForms}.
 */
export interface DeriveRejectedFormsOptions {
  /**
   * The separator characters whose stripping/truncation produces a rejected
   * form. Defaults to `_`, `-`, and a space — the separators that produced the
   * historical B15 defect ("B15_CONTEXT_DEATH_STOP" → "B15").
   */
  readonly separators?: readonly string[];
}

/**
 * Toggle a token's letter case in the three ways a lenient model most often
 * mutates a taught identifier: all-upper, all-lower, and first-letter-flipped.
 * Purely mechanical — no locale assumptions beyond JS default casing.
 */
function caseMutations(token: string): string[] {
  const out = new Set<string>();
  out.add(token.toUpperCase());
  out.add(token.toLowerCase());
  if (token.length > 0) {
    const first = token[0];
    const flippedFirst =
      first === first.toUpperCase() ? first.toLowerCase() : first.toUpperCase();
    out.add(flippedFirst + token.slice(1));
  }
  return [...out];
}

/**
 * Prefix-truncations at each separator boundary — the exact B15 shape: the
 * model emits the leading segment ("B15") of a compound identifier
 * ("B15_CONTEXT_DEATH_STOP") that the parser rejects.
 */
function prefixTruncations(token: string, separators: readonly string[]): string[] {
  const out = new Set<string>();
  for (const sep of separators) {
    if (!sep) continue;
    const idx = token.indexOf(sep);
    if (idx > 0) out.add(token.slice(0, idx));
  }
  return [...out];
}

/**
 * Separator-stripped forms — the same token with each separator removed
 * ("B15_CONTEXT_DEATH_STOP" → "B15CONTEXTDEATHSTOP").
 */
function separatorStripped(token: string, separators: readonly string[]): string[] {
  const out = new Set<string>();
  for (const sep of separators) {
    if (!sep) continue;
    if (token.includes(sep)) out.add(token.split(sep).join(''));
  }
  return [...out];
}

/**
 * Mechanically derive the canonical counter-examples a contract test feeds the
 * REAL parser to prove its documented fail-closed behavior (spec §2/§3.3).
 *
 * For each promised token it produces: case-mutations, prefix-truncations at
 * each separator, and separator-stripped forms. `extras` (hand-picked shapes,
 * e.g. the literal short id `B15` and the empty string) are appended. The
 * result EXCLUDES any form that collides with a genuinely-promised token — a
 * mutation that equals a real promised output is NOT a rejected form (that would
 * make the fail-closed assertion contradict the acceptance assertion). The
 * output is de-duplicated and stably ordered.
 *
 * Pure and side-effect-free. It touches no live parser and reads no I/O.
 *
 * @param vocabulary the promised output vocabulary (the taught verdict tokens).
 * @param extras hand-picked additional rejected forms (spec §2: a hand-only
 *   list invites trivial rejects, so this AUGMENTS the derived set).
 * @param options separator configuration (defaults to `_ - <space>`).
 * @returns the derived + hand-picked rejected forms, minus any that collide
 *   with a promised token, de-duplicated and stably ordered.
 */
export function deriveRejectedForms(
  vocabulary: readonly string[],
  extras: readonly string[] = [],
  options: DeriveRejectedFormsOptions = {},
): string[] {
  const separators = options.separators ?? ['_', '-', ' '];
  const promised = new Set(vocabulary);
  const derived: string[] = [];
  for (const token of vocabulary) {
    if (typeof token !== 'string' || token.length === 0) continue;
    derived.push(
      ...caseMutations(token),
      ...prefixTruncations(token, separators),
      ...separatorStripped(token, separators),
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const form of [...derived, ...extras]) {
    if (promised.has(form)) continue; // a real promised token is never a "rejected form"
    if (seen.has(form)) continue;
    seen.add(form);
    out.push(form);
  }
  return out;
}
