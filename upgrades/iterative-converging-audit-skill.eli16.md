# Iterative Converging Audit — skill + standard — Plain-English Overview

> The one-line version: a reusable "audit until a fresh look finds nothing new" skill, plus the constitution standard that makes "thorough" mean "converged."

## The problem in one breath

When you ask an agent to "find all the places we do X" — a security hole, an unsafe pattern, a missing check — it tends to sweep once, fix what it sees, and declare victory. But a single pass always has blind spots, and the fixes themselves move things around or reveal new instances. "I looked once and stopped finding things" usually means "I got tired," not "there is nothing left." So audits silently miss things, and nobody can tell a thorough audit from a lazy one after the fact.

## What already exists

- **Lots of one-off audits.** Agents already run sweeps when asked, but each is ad-hoc — no defined loop, no convergence test, no honest "I stopped early" signal.
- **The `no-*` ratchet pattern.** The codebase already uses CI tests that fail when a banned pattern reappears (for example the new `no-silent-llm-fallback` test). Those are the "standing guard" that keeps an audit from silently regressing — but there was no general method that told you to leave one.
- **The constitution registry** (`docs/STANDARDS-REGISTRY.md`) — the place where earned standards live. It did not yet name the iterative-audit principle, even though the operator had asked for it more than once.

## What this adds

A new built-in skill, `/iterative-converging-audit`, that any agent can invoke for any find-all task. It encodes the loop explicitly: FRAME the target and search surface; AUDIT (round 1) recording every finding; FIX or classify each finding with a written reason; RE-AUDIT the whole surface again — because your search surface grew and the fixes moved things; and repeat until a clean pass returns zero new discoveries. Only then may you call it converged, and you state how many rounds it took. If you stop for time or budget, you must say "incomplete" — never dress up an exhausted audit as a thorough one. The last step says: where the pattern can be expressed in CI, leave a ratchet so the converged state cannot silently un-converge on the next commit.

Alongside the skill, two constitution standards are added to the registry: "Iterative Audit to Convergence" (the principle above) and its paired "No Silent Degradation to Brittle Fallback" (a gating LLM call must swap provider or fail closed, never silently drop to a brittle heuristic) — the safety standard whose own audit is the skill's first worked example.

## The new pieces

- **The skill** — a methodology document installed to every agent's skill set. It is process, not code: it does not call any API; it tells the agent how to run an honest, converging audit and how to leave a standing guard behind.
- **The standards** — durable entries in the constitution, each with the "earned from" story so future agents know why the rule exists.

## The safeguards

**Prevents fake thoroughness.** The honesty rule — say "incomplete" when you stopped early — is the core guard. It makes a half-done audit legible instead of indistinguishable from a complete one.

**Prevents silent regression.** The standing-guard step turns a converged audit into a CI ratchet wherever possible, so the next commit can't quietly undo it.

**Prevents accepted findings from rotting.** An accepted (won't-fix) finding must carry a written reason, so a later reader can tell "reviewed and fine" from "missed."

## What ships when

One PR. The skill ships to every agent through the normal built-in-skill install path; existing agents pick it up on their next update. Nothing is enabled or disabled — it is a new capability plus two documented standards.
