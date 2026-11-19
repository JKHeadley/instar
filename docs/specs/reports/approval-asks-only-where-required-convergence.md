# Convergence Report — Ask the operator to approve only what needs them

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI in all three rounds:
- Round 1: SERIOUS ISSUES, 4 findings.
- Round 2: SERIOUS ISSUES, 2 design findings and 1 precision finding.
- Round 3: MINOR ISSUES, 1 design point resolved as a recorded decision, plus 2 precision findings.

Gemini was not authed on this agent (`gemini-not-authed`). The Anthropic clean-door family was available
but not run.

## ELI10 Overview

On 2026-11-17 a build session asked Justin to approve pull request 3326, which changed neither of the two
constitution files he owns. It also told him the repository needed someone else's approval. That was
false: the repository's rules require no review for that change. The session was following its own
instructions:
- The build skill still described an approval rule GitHub dropped in August.
- Both skills called approval "the user's step".
- A helper on every outgoing message asks GitHub to make Justin a reviewer on any PR the agent links.

The converged fix corrects the instructions and stops that helper asking when nothing needs approval. It
does this without adding any new check that can hold a message. The instructions no longer state
repository rules from memory. They say to run the merge tool, which reads GitHub live. The rule goes into
the instar repository's own CLAUDE.md, which every build session reads, and into every agent's feature
notes. The helper reads GitHub's own rules for each linked PR and skips the review request only when they
show, for certain, that nobody's approval is needed. Anything uncertain keeps today's behaviour.

## Original vs Converged

- **The outbound-gate rule was removed.** The first draft added a new sub-clause to the outgoing-message
  check (B17) that could hold a message asking Justin to approve a PR needing no approval. All three
  round-1 internal reviewers and GPT-6 Astra found it unnecessary once the causes were fixed (2.0 Rule
  116, simplest robust route). They also found it risky: its GitHub fact had blind spots, and it would
  have held messages on other operators' repositories. It is now a recorded decision to reconsider only on
  a measured recurrence.
- **The GitHub fact got strict.**
  - The draft counted an unreadable branch-protection answer as "no protection". Every unread input is now
    "unknown".
  - Classic protection is judged from GitHub's own computed review decision.
  - Ruleset parameters outside a known list are "unknown", and their names are logged.
  - CODEOWNERS is read from all three locations GitHub uses.
  - Renamed files count by their old path.
  - The change applies only to repositories that name a code-owner review. Every other repository keeps
    today's behaviour (Sovereignty).
- **The memo cache was removed.** It could serve a stale answer after a push. The fact now has its own
  6 s budget inside the hook's existing 10 s.
- **The skill text stopped stating repository facts.** The first draft swapped one hard-coded ruleset fact
  for another. The converged text says: read it live through `safe-merge`, and an approval the operator
  reserved comes first.
- **The instructions reach the actual build session.** An awareness entry alone does not reach a session
  in an instar worktree. The rule is now also a Standard in the repository's CLAUDE.md.
- **A second stale instruction was found and fixed.** The core instruction section "PR links ask for the
  review on GitHub too" described the hook as asking on every PR. It is reworded, with an in-place
  migration for full-layout agents.
- **The migration is precise.** The draft re-copied whole files when a heading matched, which could
  overwrite customized copies. It now replaces only exact sentences from one table, in the canonical copy
  and both renderings, and re-stamps the renderings it keeps in sync.
- **`publish-spec-review` is unchanged.** It is used only for a spec that needs the operator's approval.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security+adversarial, scalability+integration, decisions+lessons, codex; constitution check ran (8 flags) | ~17 (deduplicated to 9 themes) | 10 | Gate rule dropped; strict fact; skill text live-read; precise migration |
| 2 | security/adversarial/scale/integration, decisions/lessons, codex; constitution check ran (4 flags) | 7 | 9 | Delivery via repo CLAUDE.md; PR-links section reworded; renames; fact budget; precedence; canonical+rendering migration |
| 3 | all-six-lenses internal (0 design), codex (1 design point resolved as decision 7); constitution check ran (5 flags, engaged) | 0 that change the build | 7 | Decision 7 recorded; wording only |

Internal reviewers ran on the authoring session's model (claude-opus-5-5) in every round. The six lenses
were paired in rounds 1 and 2 and covered by one reviewer in round 3. No lens was skipped.

## Proportion

Tier 2; about 10 source/skill files changed plus tests (~400 source LOC). 3 of 6 rounds used. In line with
a change that touches outbound-messaging behaviour and the fleet's instructions.

## Left behind

- safe-merge and the green-PR watcher read CODEOWNERS only from `.github/` and treat a 404 as "nothing
  owned". Pre-existing and narrower than GitHub. Queued to `/feedback`.
- Precommit enforcement of operator `approved-by` on constitution specs was not added. GitHub's
  code-owner review on the registry PR is the enforced point.
- A real-channel proof of the hook needs the released build. It is a post-release check named in the
  spec.
- `parseCodeowners` treats malformed lines as owning nothing (pre-existing helper behaviour).
- The 1.x registry lacks 2.0 Rule 82's "asked only for the constitution" sentence. It is reported to the
  operator as a constitutional finding, not changed here.
- The spec uses "exact" loosely in places. Corrected where it governs the decision row.
- Repeated constitution-check flags (*Structure beats Willpower*, *Conservative Outbound*, *Live-User-Channel
  Proof*) are engaged in the spec's engagement section. They are reasoned decisions, not open defects.

## Full Findings Catalog

Round 1 (themes; each raised by one or more reviewers):
1. **403/404 on classic protection read as "none"** (DESIGN, high; codex, security, integration,
   constitution check). Resolved: GitHub's review decision; unread means unknown.
2. **Unknown ruleset parameters** (`required_reviewers`, the unattributed-changes flag) (DESIGN, high;
   security). Resolved: allowlist, with unknown otherwise.
3. **Part 4 scope: any repo, any operator** (DESIGN, med; security, lessons). Resolved: Part 4 dropped;
   Part 3 scoped to governed repos.
4. **Part 4 unnecessary, no switch** (DESIGN, high; lessons, codex, integration). Resolved: dropped.
5. **Memo keyed by PR, not head; cost** (DESIGN; security, scalability, lessons). Resolved: memo removed.
6. **Migration fingerprint is not proof of stock** (DESIGN; codex, lessons, constitution check). Resolved:
   exact sentences.
7. **Skill text swaps one hard-coded repo fact for another** (DESIGN, high; lessons). Resolved: live read.
8. **publish-spec-review flag misclassified; FYI push noise** (DESIGN; lessons, constitution check).
   Resolved: no flag, no handoff for non-operator specs.
9. **CODEOWNERS locations** (DESIGN, low; integration, lessons). Resolved: three locations.
10. Precision (rollback wording, limits basis, live proof, directive reading, naming) went to Left behind or
    was fixed in passing.

Round 2:
1. **The awareness entry does not reach worktree build sessions** (DESIGN, high; lessons). Resolved:
   repo CLAUDE.md Standard.
2. **The stale core section "PR links ask for the review"** (DESIGN, high; lessons). Resolved: reworded,
   with migration.
3. **Awareness entry sovereignty for agents without safe-merge** (DESIGN, med; lessons). Resolved: scoped
   wording.
4. **A timeout makes the operator message worse** (DESIGN, med; integration). Resolved: 6 s fact budget,
   unknown on timeout.
5. **Renames bypass the owned-file check** (DESIGN, low; adversarial). Resolved: `previous_filename`.
6. **Reservation precedence** (DESIGN; codex). Resolved: reservations first.
7. **reviewDecision contract evidence** (DESIGN; codex). Resolved: evidence plus honest basis plus cost
   bound.
8. Precision: canonical/rendering copies (fixed: the migration covers all three), variants (checked:
   single), third code-ownership reader (recorded), decision-row basis (relabelled), existing requests
   (operator chore), unattributed-flag evidence (narrowed).

Round 3:
1. **Codex DESIGN: a reserved non-code-owned approval gets no GitHub request.** Resolved as Frontloaded
   Decision 7: the chat yes is the approval of record, and the switch covers operators who want requests.
   No build change.
2. Precision: timing statement, "exact" wording, `per_page`, an unreachable CODEOWNERS branch noted,
   `--admin` dropped from the awareness text, line list replaced by the table, base-ref read stated.
   All fixed in passing.

## Convergence verdict

Converged at round 3. The final round found nothing that changes what gets built; 7 items left behind. Spec
is ready to approve and build.
