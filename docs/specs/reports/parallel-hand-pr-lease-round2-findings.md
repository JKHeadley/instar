# Parallel-Hand PR Lease — Round 2 findings (consolidated)

Round 2 reviewers (on the round-1 rewrite): 3 combined internal (security+adversarial; scalability+integration/multi-machine; decision-completeness+lessons-aware) + external codex-cli/gpt-5.5 (MINOR ISSUES). gemini-cli degraded (timeout) — codex satisfied the external pass.

## NET-NEW BLOCKER (the round-1 rewrite introduced it)

- **B1-REGRESSION (security+adversarial) — enforcement targeted the WRONG chokepoint.** `src/core/SafeGitExecutor.ts` is instar's INTERNAL TypeScript git wrapper (push callsites: nuke/SyncOrchestrator/etc.). The #1183 thrash was two Claude Code SESSIONS running `git push --force` from their **Bash tool**, which never enters TypeScript → never reaches SafeGitExecutor. A gate there tests green and protects NOTHING against the observed failure. FIX (applied in v3): enforce at a **PreToolUse Bash hook** (`pr-hand-lease-guard.js`, sibling to `dangerous-command-guard.sh` which already matches `git push`) — where the agent pushes are AND where the session topic is ambient (also solving M-A: holderTopicId isn't in scope at a static SafeGitExecutor call). SafeGitExecutor keeps the check as defense-in-depth for internal pushes only.

## Material (applied in v3)

- **M-A (security+adversarial) — holderTopicId unavailable at the SafeGitExecutor gate.** Resolved by the B1-REGRESSION move to the PreToolUse hook (topic ambient there).
- **M-B (security+adversarial) — fail-open-on-corrupt abuse + read-path atomicity.** v3: the read relies on the atomic-`rename` write so a concurrent write is never seen as torn (only genuine corruption fails open); a recurring fail-open on the same branch raises ONE attention item; §8 snapshot-exclusion is now a real mechanism (ephemeral-state denylist + a unit test asserting the path is on it), not an unenforced MUST.
- **M-D (security+adversarial) — §3.9 forced release must reuse the §3.3 atomic-CAS** (else the ceiling reintroduces the double-heal race). v3: §3.9 states it is exactly the §3.4 step-4 auto-heal CAS path with "past maxHoldMs" as trigger.
- **codex#1 (R2) — cross-machine maxHold-vs-foreign-conservatism precedence.** v3 §3.5: `maxHoldMs` OVERRIDES foreign-machine "never judged dead" (with a loud attention item) so "can never wedge" holds even cross-machine, at the cost of an explicitly-accepted rare cross-machine double-drive window past 90m.
- **codex#2 (R2) — branch-key canonicalization.** v3 §3.1: `canonicalPushKey` normalizes the destination ref to `refs/heads/<name>` from the actual push command (handles `HEAD:foo`, no-refspec→upstream, detached→fail-open, `--delete`→not-gated); pure function, tested over all variants.
- **codex#3 (R2) — single-funnel proof.** v3 §4: an anti-regression lint asserts the hook pattern covers `git push`/`-f`/`--force`/`HEAD:` forms AND no `src/` raw `git push` bypasses SafeGitExecutor.

## Minor (applied in v3)

- **M-C — holderSessionId key consistency** (tmux session name at both write and lookup; tested a live holder past TTL is found present).
- **C-E — dangling §3.4.1 ref** — none in the spec body (was a prompt artifact); §8 wording corrected to the hook.
- **codex#4 (R2) — git-ref CAS dismissed too quickly.** v3 §9: strengthened — the network-dependency objection is conceded weak; the real defer reasons (shared-remote state, hot-path round-trip, same-machine incident) are stated, and git-ref CAS is named the PRIMARY §9b cross-machine candidate.
- **codex#5 — terminology for an external implementer** (minor; the spec is internal-audience, terms are defined inline where load-bearing).

## Convergence verdict for round 2
2 of 3 internal reviewers + the lessons/decision reviewer reported CONVERGENCE SIGNAL on everything EXCEPT B1-REGRESSION, which the security+adversarial reviewer caught as a hard blocker. So round 2 did NOT converge. v3 re-targets enforcement to the PreToolUse Bash hook + folds all material/minor findings → round 3 re-review pending.
