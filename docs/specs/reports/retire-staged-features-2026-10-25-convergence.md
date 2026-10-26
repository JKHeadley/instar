# Convergence Report — Retire five staged features the 2026-10-25 maturation review voted to retire

## Cross-model review: codex-cli:gpt-6-astra

RAN. A real GPT-tier external pass ran through the agent's codex CLI in all three
rounds (round 1 MINOR ISSUES, round 2 SERIOUS ISSUES, round 3 MINOR ISSUES — zero
DESIGN findings in round 3). Gemini was not authed (`gemini-not-authed`); grok not
enabled.

Clean-door Anthropic read (`clean-door-anthropic-review: claude-code:claude-fable-5`,
NOT a cross-model opinion): ran all three rounds (MINOR / MINOR / MINOR; zero
DESIGN findings in round 3).

Per-round internal model (D7 disclosure): the internal panel ran as one
general-purpose subagent per round on the authoring session's model (Fable 5.1);
no silent drop to opus observed.

## ELI10 Overview

Instar keeps many features switched off until there is proof they help. A review
on 2026-10-25 asked two different AI model families, for each switched-off
feature, "turn it on, keep testing, or throw it away?" Five got "throw it away"
from both. This spec removes them: two settings nothing reads, a watch-only
experiment that flagged far too many replies, a never-enabled early-compaction
helper, a stray setting Instar never defined, and two "did the user just ask me to
move / re-model this conversation?" recognizers that ran watch-only for months,
errored on most messages, and never once found a message to act on — while the
agent already handles those requests by calling explicit routes.

Users notice nothing on almost every agent, because all five were off. Settings
files get shorter, an instruction paragraph disappears, and two instruction cards
get their wording corrected so they no longer suggest the server catches
plain-language commands.

## Original vs Converged

Originally the spec listed the five items and a tidy "delete the key, strip the
paragraph" migration. Review found the deletion touched far more than the spec
knew: the relocation code block also builds the topic pin store that twenty other
places use (now kept), a helper component existed only for one deleted flag (now
retired too), the Codex/Gemini copies of the instruction file would have kept the
paragraph (now stripped there too), three registries (a route allowlist, a parity
test, a shrink-only lint baseline) would have failed the build, two decision-quality
census rows had to be declared removed, and two instruction cards still described
the deleted path (now reworded, with the migrator's own insert text updated and
the exact deployed wordings matched).

The migration also hardened: a marker instead of a perpetual key-scrubber; the stray
`quotaLimits` key deleted only when it equals the known junk value; every removed
block's known scalar values recorded in the update output (never an undefined
key's value, because that output reaches a Telegram notice); the instruction
paragraph stripped only on an exact match against a kept frozen copy, with a
hand-edited one left alone and reported honestly where that report actually lands.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | gate (Maturation Path), codex (1 D), clean-door (0 D), internal panel (8 D) | 9 | 15 | consumers added, pin store kept, StandardsCoverageEnrichment retired, mirrors stripped, census rows declared, cards reworded + migration |
| 2 | gate (No Manual Work), codex (2 D), clean-door (1 D), internal panel (9 D) | 12 | 13 | exact-match strip vs frozen card, marker, quotaLimits deep-equal, scalar-only recording, `_instar_noMigrate`, both card wordings, propose header + codes, closeout bullet, decision-quality sentence corrected |
| 3 (cap) | gate (Maturation Path, re-flag), codex (0 D), clean-door (0 D), internal panel (4 D on card literals) | 4 (applied at cap) | 10 | both trailing sentences, drain-leg closeout wording, migrator insert constants, REVIEW-line repetition stated, maturation plan added |

Standards-Conformance Gate: round 1 ran (93 standards, 1 flag — Maturation Path);
round 2 ran (93, 1 flag — No Manual Work); round 3 ran (93, 1 flag — Maturation
Path). Signal-only; answered in the spec's "Relation to the Maturation Path
standard" paragraph (retirement resolves the article's own "earned from" failure —
features left inert forever) and in the agent-addressed / accepted-residue wording.

Externals were never delta-skipped: the body hash changed every round
(301fc681… → dd5107c0… → f7e4946f…).

## Proportion

Tier 1 (reversible by revert) but large in surface: ~45 files touched, ~1,100 LOC
removed, 1 migration step added. 3 rounds used of the Tier-1 cap of 3. ⚠ The cap
was reached; the reason is breadth, not a design dispute — each round found more
consumers of the deleted code rather than disagreeing on the design.

## Left behind

Applied at the cap without a fourth round (round-3 panel, factual literals):
- F1 both trailing-sentence wordings — applied.
- F2 closeout bullet: drain-leg-first wording — applied.
- F3 migrator insert constants updated; replace runs after inserts — applied.
- F4 REVIEW line repeats per update while a hand-edited card remains — stated.

Precision, not iterated:
- Codex r1/r2/r3: "byte-identical" narrowed to server dispatch; mixed-version
  residue stated; 68%/25% metric definition — accepted as the review's recorded
  numbers, retirement rests on redundancy + cost regardless (one line added).
- Clean-door r1–r3: grep criterion exemption (done); rollback honesty (done);
  single-wording assumption for the frozen jev card — the fallback is
  non-destructive; `git log -S` on the generator is a build-phase check; line
  anchors rot — paired with identifiers where cheap; managed-region markers for
  future generated cards → feedback queue (`/feedback`), not this PR.
- Internal r1 P1–P9, r2 P1–P9, r3 F5–F7: folded where one-line (exclusion-row
  wording, dark-gate line map, `nlBoundOperator` closure-local, propose 400/503,
  channel anchors); the rest are naming/citation.
- Gate "No Manual Work" (r2) and "Maturation Path" (r1, r3): answered in-spec;
  no gate re-run after the final literal edits (cap).

## Full Findings Catalog

### Round 1
- gate · Maturation Path · possible-violation → paragraph added: retirement is
  the review's third outcome, nothing is promoted; decision recorded.
- codex · DESIGN · strip predicate deletes hand-edited paragraph → exact match
  (round 2), frozen constant (round 2/3).
- codex · PRECISION ×3 · rollback "no data lost"; criterion-1 self-contradiction;
  byte-identical scope → all reworded.
- clean-door · PRECISION ×3 · same three → reworded.
- panel · DESIGN ×8 · mirrors keep card; pin store built in deleted block;
  CapabilityIndex row; parity-test row; bounded-judgment baseline; retire
  StandardsCoverageEnrichment; decision points not "none"; agent-awareness
  cards → all resolved in round-2 text.
- panel · PRECISION ×9 · dark-gate exclusions wording; manifest exclusion
  wording; dark-gate line map; grep identifiers; 4 s latency; strip blank line;
  site docs pages; quotaLimits wording; comments list → folded.

### Round 2
- gate · No Manual Work → REVIEW line not an operator chore; residue accepted.
- codex · DESIGN ×2 · prefix match deletes edited remainder → exact match;
  disabled-block custom values lost silently → every removed block's scalars
  recorded.
- codex · PRECISION · equivalence claims scope → narrowed.
- clean-door · DESIGN · marker-less perpetual scrubber + quotaLimits provenance →
  marker + deep-equal junk rule.
- clean-door · PRECISION ×3 · manifest order-independence (added); historical
  card variant (build-phase check); glossary (not done).
- panel · DESIGN ×9 · two deployed wordings; trigger + closeout bullets; propose
  header/codes; strip rule precedent; REVIEW channel honesty; grep
  `intentClassifier` scope; decision-quality sentence wrong; echo only scalars;
  `_instar_noMigrate` → all resolved in round-3 text.
- panel · PRECISION ×9 → folded or left.

### Round 3
- gate · Maturation Path (re-flag) → maturation plan section added; position
  unchanged (retirement ≠ graduation exit).
- codex · PRECISION ×3 · residue on migrated machine (stated); enabled-install
  scope (stated); metric definitions (left).
- clean-door · PRECISION ×4 · residue (stated); re-land `-v2` (added); historical
  variants (build check); anchors (partly).
- panel · DESIGN ×4 (F1–F4) → applied at cap, see Left behind.
- panel · PRECISION ×3 (F5–F7) → F5 applied; F6 anchors added; F7 cosmetic.

## Convergence verdict

Converged at round 3 (Tier-1 cap). The final round's external passes found nothing
that changes what gets built; the internal panel's four remaining design findings
were literal corrections to the card text and were applied at the cap. 10 items
left behind. No safety, security or data-loss finding remains open. Spec is ready
for approval.
