# Mentor autoloop prompt: gate-compliance line

Instar has an automated "mentor loop" — a prompt that tells a developer agent how to run one cycle of dogfooding a mentee agent: check its health, assign it a real task, observe, and fix what breaks as a proper PR.

That prompt already teaches the ship discipline (three test tiers, the dev gate, verify-before-claim). But it said nothing about the repo's *ratchet gates* — CI checks like no-silent-fallbacks that count known-bad patterns and fail if the count ever goes UP.

We learned why that matters the hard way: a spec told the builder a helper should be "best-effort, never throws." The builder did exactly that — wrapped it in a catch that swallowed the error — and CI went red, because a swallowed catch is exactly what the no-silent-fallbacks ratchet counts. The spec's own wording invited the failure.

This change adds one paragraph to the mentor-loop prompt: an intentional fail-open catch must either report the failure (through DegradationReporter) or carry an inline `@silent-fallback-ok` justification — and you never bump a ratchet baseline just to get CI green. It also tells the mentor to spell these notes out whenever it authors a task brief or spec for another agent, so the next builder doesn't get trapped by well-meaning "never throws" guidance.

One prompt paragraph, three new test assertions locking it in. No behavior change anywhere else.
