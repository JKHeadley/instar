# Side-effects review — Lessons-aware reviewer (8th /spec-converge reviewer)

Per L6 (Side-effects review gate). Seven dimensions, every one walked.

## 1. Over-block / under-block

**Over-block risk.** The lessons-aware reviewer is added to every convergence round and is non-skippable. A convergence run that would have passed under the previous 7-reviewer regime can now stall on a lessons-aware finding even when the spec is shipping value with low risk. Mitigation: findings are severity-tagged (critical / high / medium / low). Only critical and high block convergence; medium and low are noted but non-blocking, same as other reviewers' minor findings. A spec author can also acknowledge a finding by adding a `lessons-engaged:` frontmatter entry explaining the deviation with non-recurrence-risk justification (the same pattern P10 already prescribes for deferrals).

**Under-block risk.** The reviewer is an LLM running against a markdown index. It can miss subtle contradictions or fail to engage with lessons the index doesn't capture clearly. Mitigation: the canonical index is append-only and grows as new lessons are discovered. The reviewer template prompts the model to check the agent's `.instar/memory/feedback_*.md` entries directly, so per-agent specific lessons surface even before they're promoted to the canonical index. v0.2 adds a deterministic check that the convergence report contains a `## Lessons-aware findings` section before the convergence tag is written — defense in depth against the reviewer silently erroring out.

## 2. Level-of-abstraction fit

The reviewer lives in `skills/spec-converge/` — exactly where the other 7 reviewers live. It's a sibling, not a special case. The prompt template is the same shape as the other reviewer templates. Wiring in SKILL.md is a sibling list item, not a new phase. This is the right level: the convergence skill is the orchestrator, the reviewer is a parallel participant, the index is the substrate it consults.

The lessons-aware reviewer is NOT a primitive (not Layer-3), NOT a sentinel (not running in production), NOT a hook (not a programmatic gate). It's a parallel reviewer in a parallel-reviewer pipeline. Topology confirmed before drafting per L3.

## 3. Signal vs Authority compliance

The reviewer emits **signals**, not authority. Each finding is structured output: severity, principle/lesson cited, contradicting text, recommended action. The `/spec-converge` skill's existing convergence-comparison Haiku-class LLM is the authority that decides whether the finding is material enough to require iteration. The spec author + the user (via `approved: true` tag) are the final authority on whether to ship.

This matches the signal-vs-authority pattern (B11): brittle/low-context detectors emit signals; only a higher-level intelligent gate with full context has blocking authority. The reviewer is a detector. The skill orchestrator + author + user are the gate.

## 4. Interactions with adjacent systems

**`/spec-converge` orchestration.** The reviewer is the 5th internal of 8 total. Parallel spawn happens in Phase 1. The skill's existing convergence-comparison logic treats lessons-aware findings the same way it treats other reviewers' findings — no special-case logic. No race conditions because all 8 run in parallel and complete before Phase 2.

**`/instar-dev` pre-commit gate.** Unchanged. The `review-convergence:` tag is still the only artifact `/instar-dev` checks. The reviewer's presence is structural inside `/spec-converge`, invisible to `/instar-dev`.

**Pattern-instance abbreviated convergence.** When externals (GPT/Gemini/Grok) are skipped to save cost, the lessons-aware reviewer MUST still run. This is documented in SKILL.md as the structural compensation for skipping externals. Interaction confirmed: abbreviated convergence cost is now (4 internals + 1 lessons-aware) ≈ 5 LLM calls instead of (4 internals + 3 externals) ≈ 7. The lessons-aware reviewer adds 1 call to abbreviated convergence and 1 call to full convergence.

**The canonical index (`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`).** The reviewer reads the index. The index is append-only — old lessons stay even after infrastructure absorbs them. If the index file is missing or malformed, the reviewer template prompt instructs the model to fail loudly rather than silently pass.

**Per-agent `.instar/memory/feedback_*.md`.** The reviewer template reads the running agent's local memory entries. This means a per-agent lesson (e.g. Echo's `feedback_spec_converge_pre_auth_circular.md`) surfaces during convergence even before it's promoted to the canonical index. Interaction is read-only — the reviewer never writes back to memory.

## 5. Rollback cost

Low. The reviewer is two files (the template + a SKILL.md edit). Reverting the SKILL.md edit removes the reviewer from the spawn list. The template file becomes dead weight but doesn't break anything. No data migration. No deployed-agent contract change beyond "expect one more reviewer in the convergence report."

The agent-facing change: `instar agents updates apply` rolls out the new SKILL.md (built-in skill content migration via `PostUpdateMigrator` per Migration Parity §5). Existing agents get the new reviewer on their next update. New agents get it from `init`.

## 6. Backwards compatibility / drift surface

Backwards-compatible. Specs that already passed convergence under the 7-reviewer regime keep their `review-convergence:` tag. The new reviewer applies prospectively to new convergence runs.

**Drift surface.** The canonical index will grow over time. The reviewer prompt template hardcodes the index path (`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`). If the index is renamed or moved, the reviewer breaks silently. Mitigation: add the path check to the v0.2 deterministic convergence-tag enforcement (refuse to write the tag if the reviewer couldn't load the index).

A second drift surface: the canonical index format. The reviewer's prompt assumes P1-P10 / L1-L17 / B1-B39 numbering. If new principles or lessons land with a different shape, the prompt may not parse them. The index file's structure is the contract; documented in the file header.

## 7. Authorization / Trust posture

The reviewer is a Tier-1 LLM-supervised participant inside the spec-convergence pipeline (per P7). It does NOT execute mutations — it reads files, generates findings, emits output. No new permissions surfaced. No new credentials needed.

The reviewer does not call external APIs. It runs as a Claude subagent inside the convergence skill's existing execution context, same trust posture as the other 4 internal reviewers.

## Outcome

Ship.

The seven-dimension walk surfaced two follow-ups, both already tracked:

1. **v0.2 deterministic convergence-tag check** — refuse to write the tag if the report doesn't contain a `## Lessons-aware findings` section AND if the canonical index path can't be loaded. Already in the spec's "Deferred items" section.
2. **Index-path drift guard** — the v0.2 check above subsumes this. Same item.

No item rises to "block ship for v0.1."
