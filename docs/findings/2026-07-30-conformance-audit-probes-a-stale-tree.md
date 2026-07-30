---
title: "The conformance audit probes a stale source tree and reports it as analysable"
date: 2026-07-30
author: echo
machine: Mac Mini
severity: high
status: open
kind: finding
relates:
  - "docs/findings/2026-07-30-correction-loop-cannot-promote.md"
  - "docs/STANDARDS-REGISTRY.md"
---

## The claim

`GET /conformance/coverage` reports **30.5% of constitutional standards enforced with 137 dangling guard
references**. Against the real source tree the same code reports **64.6% with zero dangling**. The audit is
not failing — it is succeeding against a source tree two months old and less than half the size, and
reporting `analyzable: true` while it does so.

Every one of the 137 "dangling" references resolves. None of them is a real finding.

## Evidence, from the audit's own self-report

`GET /conformance/coverage` returns the tree it probed and the registry it read. On this machine:

| field | value |
|---|---|
| probed `projectDir` | the agent home |
| `analyzable` | **true** |
| `markersFound` | `src/server/routes.ts`, `src/core` |
| registry path | the packed `standards-registry.md` **inside the installed package** |
| reported ratio / dangling | **0.3049 / 137** |

The agent home genuinely contains a `src/` copy. It is dated **2026-05-28** and holds **15,216** lines in
`src/server/routes.ts` against the current source's **34,698** — under half, and two months stale. Both
probe markers exist in it, so the probe answers "yes, analysable", and the audit proceeds.

Running the auditor's **own compiled `computeCoverage`** — unmodified, same registry — and changing only
`projectDir` to a current checkout yields **0.6463 / 0 dangling / 25 gaps**. One variable, opposite answer.

## Why the obvious fix is wrong

The natural repair is "the registry is resolved through a dedicated resolver, so derive the project root
from that resolution instead of from config." **This does not work, and it is worth recording so nobody
spends time on it.**

`resolveStandardsRegistry()` returns the path of the **packed registry inside the installed package**
(`…/node_modules/instar/dist/data/standards-registry.md`), with integrity basis `packed-meta-match`. That
resolution is *correct* — it is a version-stamped copy. But deriving a root from it lands in the package's
build output, which contains no `src/` at all. `probeGuardTree` would then find no markers, `analyzable`
would be **false**, and the route would report that it cannot analyse anything — on every install,
including one with a real checkout sitting beside it.

That is honest, and it removes the capability rather than repairing it. The registry and the source tree
simply do not share a root.

## The actual defect

`probeGuardTree` asks **"can these references resolve here?"** — a question about *capability*. It cannot
ask **"is this the tree the registry describes?"** — a question about *identity*. A stale copy passes the
capability question by construction, so the failure is silent and the output is confident.

**The same module already solves this one layer over, for the registry.** A resolution carries an
`integrity` basis, and `earnsVerified()` decides whether that basis is strong enough; when it is not, the
report says so in its own words:

> *"internal checks passed over 82 standards parsed from … but no integrity basis was supplied with this
> registry — so nothing establishes this is the CURRENT constitution rather than a coherent older copy; a
> stale registry passes every internal check by construction"*

That sentence is exactly the guard-tree's problem, written about the registry. The guard tree has no
equivalent, and that absence is the defect.

## Direction (a design change, not a field swap)

Give the probed tree a provenance basis mirroring the registry's: establish whether the tree corresponds to
the version the registry came from, and when that cannot be established, report the coverage as
**untrustworthy** rather than emitting a confident ratio from an unrelated tree. The shape of the
correct answer already exists in the same file; what is missing is applying it to the second input.

Deliberately not specified here: how the correspondence is established (a version stamp, a content
fingerprint, a git identity), and what a dev agent with several checkouts should resolve to. Those are the
real design questions and they deserve a spec.

## What is NOT claimed

- **Not** that the probe's marker choice is wrong. Its own comment records that requiring a
  `package.json#name` marker was tried and was worse — an agent home carries `src/` and no `package.json`,
  which made the honest verdict permanently unreachable. The markers are a considered position.
- **Not** that the registry resolution is wrong. It is correct and version-stamped.
- **Not** that this is the only cause of the 30.5%. It is sufficient to explain the figure and the 137
  dangling refs — every one of which resolves against real source — but no claim is made that nothing else
  contributes.
- **Not** measured on any other agent. One machine, one ledger. The mechanism is shared code so the defect
  is expected to generalise; that is an inference.

## A process note worth more than the finding

The wrong fix above was **handed to another agent as a located, one-field defect, twice, with an acceptance
target** — before its author checked what the resolver actually returns. It was caught only because that
author later tried to build it and hit the wall. A diagnosis precise enough to sound verified is exactly the
kind that gets acted on without a second probe; the precision is what makes it dangerous.
