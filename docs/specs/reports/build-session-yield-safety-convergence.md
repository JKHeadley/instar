# Convergence Report — Build-Session Yield Safety

## Cross-model review: gemini-cli:gemini-2.5-pro

A real external (non-Claude) review ran through the agent's own gemini CLI on **every** round (rounds 1–5; the round-6 gate was the internal adversarial convergence check on an externally-reviewed body). Gemini's verdicts were consistently "MINOR ISSUES" — it corroborated the move of the dirty-check off the kill chokepoint, the timeout/fail-open hardening, and (round 4) called the design "architecturally sound," with only clarity suggestions. One gemini idea — *cage the revived session into a commit/stash/discard-only state* — was deliberately **declined** as the same brittle-block the internal lessons-aware reviewer flagged under Signal-vs-Authority.

## ELI10 Overview

A background "build" session does its work in a private copy of the code (a *worktree*) and then stops — but those sessions die the instant they stop typing, so they can vanish with their edits **never saved to git**. The work is on disk but invisible; on 2026-06-12 that lost hours. Two existing safety nets miss this exact case (one only rescues written-down *promises*; the other only *notices* the dead session's files after the fact). This spec adds the missing piece: it makes "unsaved work in a worktree" a real **wake-up signal** that brings the session back, and gives the revived session a **tracked, nagging obligation** to actually save the work — plus a **read-only backup patch** as a last resort if it dies again. It's honestly **loss-reduction, not a guarantee**, ships **off by default** (on the dev agent first), and every failure path falls back to today's behavior, never to a stuck session.

## Original vs Converged

The original draft had one load-bearing flaw and several thin spots; review changed the *design*, not just the wording:

- **The biggest change — it stopped *caging* the session.** The first draft *blocked* a revived session from stopping until it committed. Review (Signal-vs-Authority) showed that's the exact brittle-authority anti-pattern instar is built to avoid — and the fact that a backup was still needed proved the "block" was never really a guarantee. The converged design **tells** the session (a directive) and opens a **durable tracked commitment** that re-surfaces and escalates until the work is saved — structure that *enables* the mind instead of caging it.
- **It moved the git check off the hot path.** Originally a `git status` ran on the single chokepoint every session-kill flows through — which would freeze that path for *every* shutdown and pile up under load. Now the check is collected *before* the kill, time-bounded, cached against duplicate checks, and fail-open.
- **It stopped overriding the operator.** Now an explicit operator/user stop is *never* auto-revived just because the worktree is dirty.
- **It got honest about secrets and made the backup safe.** The backup is a read-only patch (never an auto-commit into your history under a fake author), it skips secret-named files and best-effort-redacts secrets from the diff (honestly scoped: common patterns, not a vault), and it's size-bounded so it can't fill your disk.
- **It declared its multi-machine behavior** (the work lives on one machine; another machine refuses to act on what it can't see) and **its ship-order dependency** on the detection feature (#1113), with a fallback so it never silently breaks.

## Iteration Summary

| Round | Reviewers run | Material findings | Spec changes |
|------|----------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration/multi-machine, decision-completeness, lessons-aware (all 6 internal) + Standards-Conformance Gate + gemini | ~35 | Full redesign: R2 reframed block→signal+beacon; dirty-check moved off chokepoint; operator-veto; junk-residue floor; preservation-patch (no secrets/no history); multi-machine posture; Frontloaded Decisions added; "loss-reduction not guarantee" framing |
| 2 | lessons-aware, adversarial, decision-completeness + gemini | ~13 | Anti-gaming (real non-empty commit required); commitment dedup; delivery via existing sweep; preservation size/symlink bounds; explicit small resurrection cap; more frontloaded defaults; honest denylist |
| 3 | adversarial, decision-completeness, lessons-aware + gemini | ~7 | Tracked-diff secret redaction + honest claim; config schema; directive injection point; evidence-strip ordering; preserve-write-failure terminal state; slow-worktree HIGH escalation |
| 4 | adversarial, decision-completeness + gemini | ~7 | Cross-machine holder-is-recovery clarification; secret-scope narrowed; build-active 2nd-sentence + secret regex + cardinality/terminal pinned in §4 |
| 5 | adversarial, decision-completeness + gemini | ~6 | realpath time-bound; concurrent dirty-check cache; #1113 ship-order + fallback; multi-worktree dedup key; preserve-failed blocklist; cross-machine terminal |
| 6 | adversarial (convergence gate) | **0** | none — **converged** |

Standards-Conformance Gate: ran round 1 (degraded/partial — fail-open; surfaced the parent-principle frontmatter nit, fixed). Honest note on method: rounds 2–6 ran a **focused** reviewer set (the mandatory lessons-aware ran rounds 1–3 and confirmed the design constitutionally sound; decision-completeness ran rounds 1–5; adversarial ran every round; the cross-model external ran rounds 1–5) rather than re-running all six internal perspectives every round — security/scalability/integration findings from round 1 were structurally addressed and re-verified by the integration-touching edits. This is a single-author convergence (Echo authored and converged), so the lessons-aware pass — the structural defense against circular self-verification — was treated as non-skippable and ran early and repeatedly.

## Full Findings Catalog (by theme; ~70 findings across 6 rounds, all resolved)

- **Authority / Signal-vs-Authority (the headline):** the first-yield *block* was a brittle authority over a session's stop → replaced with directive + durable beacon (round 1, confirmed resolved round 3); an external "cage it" alternative was contested and declined.
- **Operator authority:** explicit operator/user/emergency kills never auto-revived on dirty-worktree-alone (round 1).
- **Scalability:** synchronous `git status` on the kill chokepoint → moved to pre-kill async collection; 5s subprocess-kill timeout; 2s realpath budget; 30s per-worktree dedup cache; concurrent-burst safe (rounds 1, 5).
- **Adversarial — anti-gaming:** empty/`--allow-empty` commit can't satisfy the obligation (requires a real non-empty commit); reset/stash that destroys work triggers preservation + HIGH, never silent "done"; junk/build-residue floor prevents loop; resurrection cap (default 2) bounds revive-of-revive; preserve-failed do-not-revive blocklist (rounds 2, 3, 5).
- **Security:** command-injection (array args only, realpath, reject leading `-`); preservation patch never commits secrets — untracked secret-name denylist + tracked-diff regex redaction, honestly scoped as curated best-effort; size caps (50MB/file, 100MB total); symlink no-deref; path-escape assertion (rounds 1, 3, 4).
- **Decision-completeness:** every stop-the-agent fork frontloaded with a default in §4; durable tags (enum literal, config root, patch path, directive text, secret rules) correctly fixed; config schema object pinned (rounds 1–5).
- **Integration / multi-machine:** machine-local-by-design declared; wrong-machine revival refuses cleanly + records, holder is recovery path; migration-parity (dev-gate, ConfigDefaults, PostUpdateMigrator, CLAUDE.md, upgrade fragment, side-effects) named; #1113 ship-order + fallback declared (rounds 1, 4, 5).
- **Lessons-aware / Close-the-Loop:** the obligation is a durable re-surfacing commitment (survives stall, not just death); delivery via the existing sweep, no new poll; honest "loss-reduction not guarantee"; design confirmed Structure>Willpower-compliant (rounds 1–3).
- **Observability:** dirty-check timeouts logged WARN, ≥3 consecutive → HIGH (no silent self-disable); one Attention item per preservation patch-write, never muted-dedup (rounds 2, 3).

## Convergence verdict

**Converged at round 6.** The final adversarial gate found zero remaining material design-level gaps and judged the spec ready for implementation; the constitutional (lessons-aware) and decision-completeness passes were satisfied in earlier rounds; the external gemini pass ran every round. The remaining frontier cases the final gate enumerated (ISO-timestamp precision, Windows-native `realpath`, pathological 100-worktree sessions) are acknowledged limits or deterministic implementation details, not spec gaps. Spec is ready for user review and approval. **This skill does not apply `approved: true` — that is the operator's step after reading this report.**
