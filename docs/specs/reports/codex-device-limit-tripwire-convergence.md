# Convergence Report — Codex device-limit tripwire

**Spec:** [docs/specs/codex-device-limit-tripwire.md](../codex-device-limit-tripwire.md)
**ELI16:** [docs/specs/codex-device-limit-tripwire.eli16.md](../codex-device-limit-tripwire.eli16.md)
**Slug:** `codex-device-limit-tripwire`
**Status:** Converged at the Tier-2 round cap (6). Round 6 still raised design findings. The one security-class finding was resolved by **removing** the surface it concerned (a cross-machine signed release button), not by accepting a risk. The three other round-6 design findings were small and concrete; they were fixed in a final edit without a seventh full round, then checked by one targeted reviewer for dangling references, contradictions and new security holes; that check found three leftover references and one wrong claim about a write path, all fixed (see Convergence verdict).

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier pass ran in rounds 2 through 6 (verdict SERIOUS ISSUES each round, with findings shrinking from structural to seam-level). Round 1 ran before the design was rewritten for the operator's Jev direction, so its external pass was deferred to the rewritten body. Gemini is not installed on this machine (`gemini-not-installed`), so GPT was the only external family.

Disclosures:
- **Standards-Conformance Gate:** ran every round. Flags by round: 3, 4, 4, 2, 0, 1. Every flag was addressed except the one listed under Left behind.
- **Internal reviewers:** six separate perspectives (security, scalability, adversarial, integration, decision-completeness, lessons-aware) ran as parallel subagents every round, on the authoring session's model (claude-opus-5-5); no silent model drop.

## ELI10 Overview

On 31 October 2026 OpenAI began limiting how many paid personal ChatGPT accounts one device can use. Echo uses five personal Codex accounts on each of three machines, so it may be over that limit. The operator chose to keep that setup and add a tripwire, and asked that the tripwire not be a brittle word match but use Jev, the fast judgement model the agent already uses.

The tripwire asks Jev (with a second model, Luna, refereeing when Jev is unsure) whether the Codex program's refusal for an account really means "this device has reached its limit". Only that refusal, seen twice five minutes apart and judged fresh both times, can bench an account, and only on that one machine. It never benches when every account on a machine refuses alike, because a real limit leaves the accounts under it working. A benched account is skipped for new work, its conversations move to other accounts, and the sign-in repair stops trying, which is the expensive failure today: up to 12 doomed sign-in attempts per account per machine. The operator gets one message per machine. Everything undoes itself when the account answers normally twice, and one setting turns it all off.

The trade-off: a model can misjudge, so the design spends most of its complexity on making a wrong "yes" cheap and self-correcting rather than on detecting more.

## Original vs Converged

- **Who decides.** The draft benched on a loose "device limit" phrase match. After the operator's direction and review, Jev (with a Luna referee, a full truth table, a budget and an outage report) judges the text; phrases only decide when to look.
- **What can bench.** The draft let a session's screen or a sign-in page bench an account. Review showed such a bench can never release itself on a signed-out account, and that screens and pages can be injected. Now only the app-server's read refusal can bench; screens trigger a read, and pages stop one repair.
- **How sure it must be.** One verdict became two separate refusals 5–60 minutes apart, both judged fresh, plus a machine floor (another account on the machine must be reading clean).
- **The ledger.** The draft relied on a "cause move" that did not exist. A real `supersedeCause` was specified, and the pool record (not the ledger) became the authority, including for repair admission.
- **Clean read.** Review found a refused live read falls back to the usage-history file and looks like a successful poll; "clean read" is now defined once as a live app-server `ok`.
- **Notices.** One HIGH notice per account × machine became one row per machine, calm unless the machine has no Codex account left; stopped repairs and the "all refusing alike" condition are on the same row; per-episode sign-in notices are suppressed for this case.
- **Undoing it.** Two clean reads release (with a persisted hold), reads back off to 6 h with a breaker after about two days, switch-off returns every cell to today's rules, and a store-level rule makes every writer of `active` end a bench.
- **Operator override.** A signed cross-machine "Use it anyway" button was designed in round 5 and removed in round 6 (see Left behind); it became a per-machine ignore list with the same posture as the on/off switch.
- **Rollout.** The draft defaulted on everywhere; it is now live on development agents (Echo) and reaches the fleet after a named graduation criterion.
- **Privacy.** Personal data and provider ids are masked before text leaves the machine; full judgement records stay machine-local and out of git, backups and the file viewer.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | gate (3), all six internal | ~25 | — | rewritten for Jev; bench only on provider text; one notice per machine |
| 2 | gate (4), GPT (3), all six | ~30 | — | two-action shape, truth table, async judge, referee on another account, supersedeCause, PII masking |
| 3 | gate (4), GPT (4), all six | ~20 | — | two observations, freshness, read discipline, store rule, admission reads pool, provenance exclusions |
| 4 | gate (2), GPT (2), five of six | ~15 | 1 | clean-read definition, afterCodexRead on every path, machine floor, CodexReadGate, settle per state |
| 5 | gate (0), GPT (3), four of six (one shared finding) | 4 | 0 | release path, requiredRoute shape, floor on latest reads, breaker lifecycle |
| 6 | gate (1), GPT (3), two of six (one shared finding) | 4 | 1 | release mandate removed; cache, notice lifecycle, page freshness fixed at the cap |

## Proportion

Tier 2 (sign-in repair, session moves, a new LLM judge). The spec grew from about 12 KB to about 49 KB over 6 rounds, the full Tier-2 cap. That is heavy for a tripwire whose job is "notice the limit and stop knocking"; most of the growth is real precision on seams the build must hit (ledger, restore path, repair states, mandate delivery). The operator's mid-review direction (Jev, not a string) caused one full redesign in round 1.

## Left behind

- **Fail the repair closed when the judge is down** (Standards-Conformance Gate, rounds 4 and 6, "No Silent Degradation to Brittle Fallback"). Accepted with reason: the tripwire does not own the existing sign-out repair, and the operator chose detection-only. When Jev and the referee are both down, the tripwire takes no action, reports the outage as a degradation, and the pre-existing repair continues unchanged. That is today's behaviour, not a new brittle fallback. Failing repairs closed would make a judge outage block every Codex sign-in, a larger harm than the one prevented.
- **Signed cross-machine release button** (round 6 security). Removed rather than built: the existing mandate delivery accepts only the follow-me re-mint shape, and a release mandate fitted to it would also authorise a re-mint enrollment. The per-machine ignore list gives the same outcome with no new authority. A future signed button needs its own mandate type and verifier; queued as a feedback item if the operator asks for a button.
- **Precision items not iterated on:** the explicit spawn-cap wording for the referee; whether switch-off also clears the ignore list (it does not; the list is the operator's); and the CLAUDE.md wording for "suspected" attribution, all settled in the text without another round.

## Full Findings Catalog

Per-round reviewer outputs are retained in the session's workflow journals (rounds 1–6) and summarised above; every DESIGN finding was either resolved in the spec (the "Added by review round 3/4/5" and "Added at the cap" test lists enumerate them) or listed under Left behind.

## Convergence verdict

Converged at round 6, the Tier-2 cap. The remaining security-class finding was resolved by removing the surface, and three small design findings were fixed in a final edit, then checked by one targeted reviewer for dangling references, contradictions and new security holes. Two items are left behind with reasons. The spec is ready for approval under the operator's standing direction that only constitution changes need his separate sign-off.
