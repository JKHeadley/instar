# ELI16 overview required for every approved spec — Plain-English Overview

> The one-line version: every spec that ships through `/instar-dev` will now require a plain-English overview alongside it, enforced by the same gate that already requires convergence and approval. The technical spec stops being the entry point for human readers; the overview takes that job.

## The problem in one breath

Specs are written for the reviewer who has to find all the bugs in them. They're dense by design — every line carries a constraint or a contract. That works great for the four parallel reviewers in `/spec-converge`. It works badly for the person who has to decide whether the *shape* of the design is right.

When Echo delivered the round-1-amended self-healing-remediator spec to Justin, the technical spec landed without a plain-English companion. The reply was: "I can't digest this without an ELI16 overview. That should be required for every spec."

So this gate makes "ELI16 overview" a structural requirement, not author discipline.

## What already exists

`/instar-dev` already has two gates on every spec it commits against:

1. The spec must have been through `/spec-converge` (writes a `review-convergence: <timestamp>` tag).
2. The user must have explicitly approved (adds `approved: true` to the frontmatter).

Both are checked by `scripts/instar-dev-precommit.js` at commit time. If either is missing, the commit is refused.

## What this adds

A third gate in the same chain: the spec must have an **ELI16 companion file**.

The companion lives next to the spec:

- Default: a sibling file at `<spec-name>.eli16.md` — e.g. `docs/specs/foo.md` pairs with `docs/specs/foo.eli16.md`.
- Alternative: the spec can point at any path via frontmatter `eli16-overview: <path>`.

The companion must be at least 800 characters of real content — roughly four or five short paragraphs. A stub doesn't count.

The gate fires in two places, the same way the existing tags do:

- At convergence: `/spec-converge` refuses to stamp the spec as converged if no ELI16 exists.
- At commit: `/instar-dev` refuses to commit if no ELI16 exists.

Both checks are deterministic — file existence and length, nothing fuzzy.

## What the ELI16 should look like

A new template lives at `skills/instar-dev/templates/eli16-overview.md` with the expected shape. It's the shape this very overview follows:

1. The one-paragraph version (the entire decision in one breath).
2. The problem in plain English.
3. What already exists vs. what this adds.
4. The new pieces.
5. The safeguards in plain terms.
6. What ships when.
7. What the reader actually needs to decide.

## The safeguards

This is a deterministic structural gate, not a judgment call. The same shape as the existing review-convergence and approved checks.

- **Forward-only.** Only specs newly committed-against after this ships have to satisfy the gate. Old specs whose work already shipped are not retroactively rejected — they're not being committed against again.
- **Single-line rollback.** If the gate over-blocks, reverting one block in each of two scripts disables it. No data migration. The check is purely additive.
- **Self-testing.** This PR's own spec ships with its own ELI16 sibling (the file you're reading). The pre-commit hook on this PR is the first real-world exercise of the gate.

## What ships when

One PR. One commit. Adds:

- The check block in `scripts/instar-dev-precommit.js`.
- The check block in `skills/spec-converge/scripts/write-convergence-tag.mjs`.
- The template at `skills/instar-dev/templates/eli16-overview.md`.
- Updates to both skill SKILL.md files documenting the new requirement.
- Unit tests for both gates.

Once the next release rolls out, every agent that runs `/spec-converge` or `/instar-dev` against the instar repo enforces this rule.

## What you actually need to decide

Reading-this-overview level: **does "ELI16 companion required" feel like the right shape for the gate?** That's the structural question. The implementation is small and self-evidently deterministic.

If yes: this ships as one PR, drives CI green, merges to main, and the next release picks it up. Every spec from then on travels with a plain-English overview by default.

If no: tell me what shape would be better — a less rigid trigger (frontmatter opt-out?), a separate workflow that doesn't gate at commit-time, a documentation-only convention with no enforcement, or something else.
