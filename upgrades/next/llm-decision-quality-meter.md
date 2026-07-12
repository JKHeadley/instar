<!-- bump: patch -->

## What Changed

The **LLM-Decision Quality Meter** (ACT-1193 uniform provenance + ACT-1194 outcome grading) — the remediation the LLM-decision audit named as the real gap. Instar has long had a *cost* meter for its AI decisions (tokens/latency per feature) but no *quality* meter: nothing recorded WHAT a high-stakes decision saw, and nothing checked afterward whether the call turned out right. This build lays that substrate:

- **Correlation spine + uniform provenance:** every enrolled high-stakes AI decision now mints a safe correlation id and records the context it saw and the choice it made (replay-proof; the caller's data is never mutated; a failed attempt's cost can never be double-counted). Provenance was wired to exactly 2 of ~59 callsites before; the census + ratchet now track the whole surface.
- **Outcome grading over time:** a deterministic, evidence-triggered grading pass stamps each recorded decision `right` / `wrong` / `unknown` as reality's evidence matures (did the killed process come back? did the "done" run actually finish?), exposed read-only at `GET /decision-quality` with a `POST /decision-quality/grade-pass` job.
- **Ships dark + dry-run (measure-only)** behind `provenance.uniformSeam` (dev-gated; `dryRun` default true → metadata-only would-writes, no durable persistence). It changes NO decision and grades nothing durably until the seam is deliberately flipped live after soak. First graded customer is process-kill decisions; the completion-judge grader is a tracked fast-follow (ACT-1202).
- **Two live production bug fixes ride along (these DO land live):** the dashboard file-browser could serve/edit the raw decision-provenance log (ACT-1200) — now denied; and the backup manager's per-file exclusion could be bypassed (ACT-1201) — now enforced.

## What to Tell Your User

Two things. First, a small privacy/robustness fix that takes effect immediately: an internal audit log could previously be opened (and edited) through the file browser, and a backup exclusion could be sidestepped — both are now closed. Second, the bigger piece is measure-only for now: I've built the machinery to grade *my own* automatic decisions — not just count how many I make or what they cost, but check whether they actually turned out right over time. That's the foundation for deciding when a bigger model or a better prompt is genuinely warranted. It's running in a safe, off-by-default mode that records but doesn't act, until it's soaked and you choose to turn it on.

## Summary of New Capabilities

- `GET /decision-quality` — read-only quality view (per-decision-point grade rates, strength-first, insufficient-evidence below sample floor, census debt, rejection counters; `?scope=pool` field-allowlisted). 503 when the seam is dark.
- `POST /decision-quality/grade-pass` — deterministic, idempotent, budget-bounded grading job (keyset cursor; returns `{graded, byRule, cursors}`).
- Correlation spine + `JudgmentProvenanceLog` uniform provenance seam (dark/dryRun behind `provenance.uniformSeam`; 59-point census + shrink-only coverage ratchet).
- Live fixes: file-browser exposure of the decision-provenance log denied (ACT-1200); backup per-file exclusion bypass closed (ACT-1201).

## Evidence

- New unit/integration/e2e tiers green (read endpoint, grade-pass idempotency + rules, "feature-alive" 200-not-503, pool field-allowlist, dryRun would-write suppression, census/ratchet). Full CI sharded suite is the merge authority.
- Converged spec (`/spec-converge`, 7 rounds; stamp validator-earned, cross-model codex-cli:gpt-5.5 ok 7/7); `docs/specs/llm-decision-quality-meter.md` + `.eli16.md` companion.
- Follow-ups tracked: ACT-1202 (completion-judge realcheck grading — needs a Stop-hook protocol change), ACT-1203 (heavy-AgentServer test isolation), ACT-1195 (bench prompt-parity).
