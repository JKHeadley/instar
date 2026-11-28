/**
 * The exact skill sentences that named the operator as approver of everything, and
 * what replaces each (Echo Bugs topic 10000002791, spec
 * docs/specs/approval-asks-only-where-required.md).
 *
 * WHY A TABLE: a build session asked the operator to approve PR #3326 because the
 * instar-dev skill said the repository required a human approval for every merge
 * (a ruleset setting removed months earlier) and both skills called approval "the
 * user's step". The bundled skills carry the new sentences; this table lets
 * PostUpdateMigrator.migrateApprovalWhereRequired() replace ONLY these sentences in
 * an installed copy, so anything else an agent changed in its copy is kept.
 * tests/unit/approval-where-required-skill-text.test.ts pins that the bundled skills
 * contain every `next` and no `prior`.
 *
 * Each `prior` is matched exactly (every shipped variant shares it; checked against
 * the git history of both files on 2026-11-17). No meaning is decided here.
 */

export interface SkillSentenceChange {
  prior: string;
  next: string;
}

export interface SkillTextChanges {
  /** Skill directory name under .instar/skills, .claude/skills and .agents/skills. */
  skill: 'instar-dev' | 'spec-converge';
  changes: SkillSentenceChange[];
}

export const APPROVAL_WHERE_REQUIRED_SKILL_TEXT: readonly SkillTextChanges[] = [
  {
    skill: 'instar-dev',
    changes: [
      {
        prior: "- The user must have reviewed the convergence report and applied `approved: true` to the spec's frontmatter.",
        next: "- The spec's frontmatter carries `approved: true` with an `approved-by` line naming who approved it and on what basis, after the convergence report was read. The agent approves its own converged spec. The operator approves only a spec that amends the constitution or the protected list (the paths `.github/CODEOWNERS` assigns to an owner), or one the operator's recorded instructions reserve to them (2.0 Rule 82: the operator is asked only for changes to the constitution and the protected list).",
      },
      {
        prior: '**When the repo itself requires a human approval** (a main-branch ruleset with `require_last_push_approval` / a required review — in force on `JKHeadley/instar` since 2026-08-22 17:03 PDT), `safe-merge` returns `refused:approval-required`. It has ALREADY requested the operator\'s review; your ONLY remaining job is to send the operator the `reviewUrl` it prints',
        next: '**Whether a merge needs a human approval is read live, never remembered.** Do not decide it from memory, from a brief or from this text: the repository\'s rules change. An approval the operator\'s recorded instructions reserve is asked for first. Otherwise `safe-merge` decides: it reads the rules at merge time and returns `refused:approval-required` only for a PR GitHub will not merge without a review (for example one touching a path `.github/CODEOWNERS` assigns to an owner). Every other green PR is merged without asking, and the operator hears what shipped, never "ready for your review" (2026-11-17, PR #3326). When `safe-merge` does refuse, it has ALREADY requested the operator\'s review; your ONLY remaining job is to send the operator the `reviewUrl` it prints',
      },
    ],
  },
  {
    skill: 'spec-converge',
    changes: [
      {
        prior: '2. The spec file has an `approved: true` entry in its frontmatter, written by the user after reading the convergence report.',
        next: '2. The spec file has an `approved: true` entry in its frontmatter, with `approved-by` naming who approved it and on what basis, written after reading the convergence report. The agent approves its own converged spec; the operator approves only a spec that amends the constitution or the protected list (the paths `.github/CODEOWNERS` assigns to an owner), or one their recorded instructions reserve to them.',
      },
      {
        prior: 'The user reads THIS before applying `approved: true`',
        next: 'The approver reads THIS before applying `approved: true`',
      },
      {
        prior: 'Spec is ready for user review and approval.',
        next: 'Spec is ready to approve and build.',
      },
      {
        prior: '(the user reads the report banner and makes an informed choice)',
        next: '(the approver reads the report banner and makes an informed choice)',
      },
      {
        prior: "The `approved: true` tag is NOT written by this skill. That's the user's step.",
        next: 'The `approved: true` tag is NOT written by this skill. It is the approver\'s separate, recorded step: the agent\'s for its own spec, the operator\'s for a constitution or protected-list amendment (see "When it runs").',
      },
      {
        prior: 'When a spec is handed to the user for review, it MUST go out with',
        next: 'A spec goes to the operator for approval only when it amends the constitution or the protected list, or their recorded instructions reserve it; any other converged spec gets no handoff message (it reaches them in the regular status update and the merged PR). When a spec IS handed to the operator for review, it MUST go out with',
      },
      {
        prior: 'The skill does NOT auto-apply `approved: true`. That requires explicit human action — editing the frontmatter or running `instar spec approve <path>` (follow-on CLI command).',
        next: 'The skill does NOT auto-apply `approved: true`. The approver applies it explicitly by editing the frontmatter, with `approved-by` recording who approved and why.',
      },
      {
        prior: "- It does not auto-approve on behalf of the user. Approval is the user's structural contribution to the process.",
        next: '- It does not auto-approve. Approval is a separate, recorded step by the approver: the agent for its own spec, the operator for a constitution or protected-list amendment.',
      },
      // spec-review-link-at-delivery (CMT-075): the retired hook criterion 8. Not an approval
      // sentence; it rides this table because the same safe sentence swap (canonical copy plus
      // both renderings, re-stamped, customized copies left alone) is exactly what it needs.
      {
        prior: 'Backstop (Structure > Willpower): the pre-messaging gate (`convergence-check.sh`, criterion 8) **blocks** any hand-sent spec-review message that lacks a rendered `/view/` link, so the requirement cannot be silently skipped even if the script is bypassed.',
        next: 'Backstop (Structure > Willpower): where it is switched on (development agents first, `toneGate.specReviewLinks.enabled`), the server\'s outbound check hands back a reply to the person that hands over a spec with no readable link (rule `B27_SPEC_REVIEW_UNLINKED`, judged by meaning, overridable with a reason). It runs only on routes that reach a person, so review verdicts between the agent\'s own sessions on the local bus are never blocked. The old pre-messaging hook criterion 8 is retired (docs/specs/spec-review-link-at-delivery.md).',
      },
    ],
  },
];

/** Apply one skill's changes to a text. Pure. `missing` lists priors absent whose next is absent too. */
export function applySkillSentenceChanges(text: string, changes: readonly SkillSentenceChange[]): { text: string; changed: number; missing: string[] } {
  let out = text;
  let changed = 0;
  const missing: string[] = [];
  for (const c of changes) {
    if (out.includes(c.prior)) {
      out = out.split(c.prior).join(c.next);
      changed += 1;
    } else if (!out.includes(c.next)) {
      missing.push(c.prior.slice(0, 80));
    }
  }
  return { text: out, changed, missing };
}
