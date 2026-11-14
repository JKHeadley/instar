# Side-Effects Review — catch "someone else will need to build that" deferrals

**Version / slug:** `someone-elses-work-gravity-well`
**Date:** `2026-11-10`
**Author:** `Echo (instar-dev)`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Bug topic 10000002523: inside an approved "fully complete this work" run, an agent wrote "will need a small button added to the app" and "app work outside this repository, recorded for the app's owner" into a spec and a progress message. No owner, no handoff, no completion-list item. Every deferral check keyed on "later / follow-up / phase 2" missed it. This change extends the existing layers, judged by meaning where an authority is involved:

- `src/core/unowned-handoff.ts` (new) — signal-only phrase pre-filter `detectUnownedHandoff`.
- `src/server/routes.ts` — the outbound reply path runs it (replies only, fail-open) and sets `signals.unownedHandoff`.
- `src/core/MessagingToneGate.ts` — when that signal fired, the B17 UNOWNED-HANDOFF sub-clause (`B17_UNOWNED_HANDOFF_SUBCLAUSE`: meaning-level, explicit pass cases, under-fire bias) is added to the prompt, the same signal-gated pattern as the B17 REACH sub-clause (#3015). The pinned static template (`TONE_GATE_PROMPT_TEMPLATE`, benchmark hash) is byte-identical; every review without the signal is unchanged.
- `src/core/PostUpdateMigrator.ts` `getDeferralDetectorHook()` — new signal-only pattern family `unownedHandoffPatterns`, suppressed when the message names a handoff (`handoffNamedPatterns`) or tracking infrastructure. Shipped to every agent by the existing always-overwrite hook migration.
- `skills/spec-converge/templates/reviewer-decision-completeness.md` — check 7, "Cross-boundary work with no route", a DESIGN finding. Shipped by the existing alwaysOverwrite template refresh.
- `.claude/skills/autonomous/SKILL.md` — Defer-to-Future-Self table row, "The cross-boundary form" section, completion_condition must cover every deliverable. New `CROSS_BOUNDARY_OWNER` marker + `upgrade()` step in `migrateAutonomousStopHookTopicKeyed`.
- `src/scaffold/templates.ts` — `SOMEONE_ELSES_WORK_TRAP` gravity well in Gravity Wells; `patchClaudeMdContent` inserts it into legacy CLAUDE.md files (content-sniff, idempotent); reference-layout agents get it through the canonical rebuild.

## Decision-point inventory

- `MessagingToneGate B17_FALSE_BLOCKER` — modify — adds a signal-gated sub-clause the LLM judge applies to outbound replies the detector flagged.
- `detectUnownedHandoff` — add — signal only, no authority.
- `deferral-detector.js` — modify — adds a signal (additionalContext checklist); never blocks.
- `spec-converge decision-completeness reviewer` — modify — adds a check an LLM reviewer applies to specs.
- Autonomous skill / CLAUDE.md — guidance text, no decision surface of their own.

---

## 1. Over-block

The B17 sub-clause could hold a message that mentions outside work which is genuinely not needed for the goal, or a message where the route is implied but not stated. Mitigated by explicit PASS cases (route named even briefly; not needed for the goal; a question to the operator about who should own it; a blocker reporting what was tried) and the UNDER-FIRE BIAS line. A held message is a 422 advisory the agent can revise or acknowledge with a reason, so the cost of an over-fire is one revision. The hook cannot over-block: it only adds context. It does add noise on some user-facing instructions ("you will need to sign in to the app first", "outside the project directory" in file-path talk); acceptable for a signal, and the B17 judge does not fire on those.

## 2. Under-block

Both pre-filters (the hook and the gate's signal) miss paraphrases ("the iOS side still has to grow a share button"); because the B17 sub-clause is only added when the signal fires, such a paraphrase reaches the gate without it. That is the accepted cost of keeping the pinned static prompt unchanged (same trade as the REACH sub-clause); the spec reviewer, skill and CLAUDE.md layers are meaning-level without a pre-filter. A message that names a fake route ("handed to the app team") passes both — the gate sees only text, the same accepted limit as B16/B17. A spec sentence is caught only when the spec goes through /spec-converge; specs written outside it are not reviewed. The autonomous completion judge itself is unchanged: if the agent writes a completion condition that omits the outside piece and never mentions it, nothing catches it beyond the skill guidance.

## 3. Level-of-abstraction fit

Right layers: the authorities (B17 judge, decision-completeness reviewer) are LLM judges with full message/spec context; the regex is confined to the existing signal-only hook. No new gate or parallel check was added; each existing deferral layer is extended in place.

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate. (hook)
- [x] Yes — but the logic is a smart gate with full conversational context (LLM-backed). (B17 sub-clause, spec reviewer)

The regex patterns carry no blocking authority: the hook only adds context, and the gate signal only decides whether the LLM sees the sub-clause. Every blocking judgment is the LLM's, by meaning.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The new regex is a signal feeding the existing B17 judge.

## 5. Interactions

The hook family runs after the existing families and adds its own checklist block; `isInfrastructureBacked` also suppresses it, so a message with `/commit-action` gets no double nudge. B17 already has STANDING-AUTHORIZATION and REACH sub-clauses; the new sub-clause cites B17 and does not change citation precedence (B15 > B16 > B17 > B18). The skill marker chain: a copy that already carries FRACTAL_8020_TRIAGE gets the CROSS_BOUNDARY_OWNER step; the FRACTAL step's own test still passes because the re-deployed bundled file carries both markers. CLAUDE.md: the canonical rebuild already contains the marker, so `patchClaudeMdContent` is a no-op there (no double insertion).

## 6. External surfaces

Outbound replies the detector flags get the extended B17 prompt (an agent-visible 422 when the judge fires). The benchmark-pinned static template is unchanged, so the benchmark-divergence detector stays valid. Agent-installed files change on update: deferral-detector.js (always overwritten, existing path), autonomous SKILL.md (stock copies only; customised copies untouched), the spec-converge reviewer template (always overwritten, existing path), CLAUDE.md (one paragraph added).

## 6b. Operator-surface quality

No operator-facing UI. The only operator-visible effect is that agent messages name a route for outside work instead of a bare "will need".

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: prompt text, hook and skill files are installed per machine by each machine's own update; no state is created.

## 8. Rollback cost

A revert restores the old gate behaviour immediately (server code) and the old hook on next update. The CLAUDE.md paragraph and the skill text would stay on agents that already received them (harmless guidance); the skill would be replaced again by the next marker bump.

## Conclusion

Extends each existing deferral layer to the cross-boundary shape, with blocking judgment only in LLM authorities and the regex kept signal-only. Safe to ship.

## Second-pass review (if required)

Independent subagent reviewer, 2026-11-10: concurred. Notes: B17 over-block low (all three conditions + four pass cases + under-fire bias); hook escaping verified on the rendered hook; migrations idempotent. Two non-blocking items fixed: the CLAUDE.md patch comment said "Gravity Wells section's end" (the code appends to the file's end; comment corrected), and §1 now names the signal's noise on user-facing instructions.

Concur with the review

After that review, a test showed the static gate prompt is pinned by the benchmark mirror (`tests/unit/benchmark-mirror-registry-agreement.test.ts`). The sub-clause text was moved, unchanged apart from one added pass case (user instructions such as "you will need to sign in to the app first", from the reviewer's false-positive note), into a signal-gated section using the REACH sub-clause's pattern. The reviewer was asked to re-check the moved version; result below.

Re-check (same reviewer): concurred. The sub-clause rides the REACH slot and is added when its own signal fires, REACH behaviour unchanged, replies only, fail-open, empty-signals guard and signal line updated. Noted trade-off: blocking depends on the regex firing first, so paraphrases go out unjudged — the same accepted limit as REACH (stated in §2). The integration test had not finished in the reviewer's run under machine load; it passes in the author's run (2/2).

Concur with the review

## Evidence pointers

- `tests/unit/deferral-detector-unowned-handoff.test.ts` — founding case nudges; named route / tracking / pulled code pass; in-repo talk and non-message commands silent.
- `tests/unit/someone-elses-work-gravity-well.test.ts` — template placement, CLAUDE.md migration (insert after anchor, append fallback, idempotent), autonomous skill marker chain from origin/main f4caf6c0, detector both sides, sub-clause present only with the signal, static template unchanged, reviewer text.
- `tests/integration/telegram-reply-unowned-handoff.test.ts` — real POST /telegram/reply: the founding message reaches the gate with the sub-clause and a B17 verdict holds it; a plain reply gets no sub-clause and is delivered.
- `tests/unit/benchmark-mirror-registry-agreement.test.ts` — still green (static prompt hash unchanged).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The existing hook, skill and prompts behaved as written; this adds coverage for a deferral shape none of them described.
