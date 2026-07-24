---
slug: throughput-github-runtime-repair
title: "Throughput GitHub runtime repair and explicit server identity"
date: 2026-07-24
author: instar-codey
review-convergence: "three-lens-security-integration-throughput-2026-07-24"
review-iterations: 2
approved: true
approved-by: User
approved-via: "Interactive Mini session, 2026-07-24: urgent fix direction explicitly authorized, including direct GraphQL preference, explicit identity, class closure across all three bare-gh call paths, full ceremony, and auto-merge."
eli16-overview: throughput-github-runtime-repair.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
---

# Throughput GitHub runtime repair and explicit server identity

## Problem

The production Throughput route executes the GitHub CLI by its bare name. Instar
servers launched by launchd do not normally inherit Homebrew's binary directory,
so the process fails with `ENOENT` and the route returns HTTP 503 on every request.
Even when the executable is discoverable, an unqualified server-side CLI call may
use the machine-global GitHub keychain seat. That identity can belong to someone
other than the agent and is not an acceptable identity source for shipped server
behavior.

Two adjacent server components share the same class: the CI failure poller invokes
the CLI directly, and the Green-PR merge watcher invokes it for reads while its
`safe-merge` child invokes it again for actuation.

## Design

1. Throughput no longer starts a CLI process. It calls GitHub GraphQL directly with
   a token resolved from `GITHUB_TOKEN`, then the agent vault's `github_token`.
   Absence of explicit identity returns the distinct `github-auth-unavailable`
   HTTP 503. Transport, schema, pagination, and count failures retain the generic
   fail-closed 503.
2. A shared server GitHub runtime resolves the two remaining CLI consumers. It
   selects an absolute executable from the two Homebrew locations or absolute PATH
   entries and constructs a child environment containing explicit `GH_TOKEN` and
   `GITHUB_TOKEN`. It never consults `gh auth` or a machine-global config.
3. Runtime resolution is cached for five minutes, including missing-token results.
   This avoids repeated vault/keychain reads from periodic pollers while bounding
   how long a token rotation takes to appear.
4. The Green-PR watcher shares one resolved runtime between read calls and the
   `safe-merge` child. The child PATH begins with the already-resolved executable
   directory, so the script's internal `gh` calls select that binary and inherit
   the same explicit identity. Missing runtime makes both contract probing and
   actuation refuse.
5. GitHub Search's `issueCount` is treated as a cardinality invariant. Counts over
   GitHub's 1,000-result Search ceiling, count changes during pagination, or a final
   fetched-count mismatch make the Throughput read fail closed rather than render
   silently incomplete metrics.
6. Throughput day buckets use the `America/Los_Angeles` timezone instead of a fixed
   UTC offset, covering both PST and PDT.

## Decision points touched

- **Throughput identity availability** — deterministic safety invariant. No token
  means a distinct unavailable response; there is no fallback identity.
- **GitHub CLI runtime availability** — deterministic safety invariant. Both an
  explicit token and executable must resolve before a remaining CLI operation.
- **Search completeness** — deterministic data-integrity invariant. Reported and
  fetched counts must agree and remain within the provider ceiling.
- **Green-PR actuation** — existing `safe-merge` authority is unchanged. This repair
  supplies its process identity and fails before it when identity is unavailable.

These are enumerable boundary checks, not contextual judgment points. Existing
lease, protected-path, check-state, head-pin, and `safe-merge` authorities remain
in place.

## Acceptance criteria

- The Throughput route succeeds with launchd-like PATH when an explicit token is
  available, without starting `gh`.
- Missing explicit identity returns HTTP 503 with
  `github-auth-unavailable`.
- Environment identity takes precedence over the vault; no code invokes `gh auth`.
- CI polling and both Green-PR read and act paths use the shared explicit runtime.
- Relative PATH entries, non-files, and non-executable candidates are rejected.
- Runtime successes and failures are cached only for a bounded interval.
- Search truncation and cardinality drift fail closed.
- Pacific day boundaries are correct in summer and winter.
- Focused tests, TypeScript, lint, repository invariants, and the complete test
  ceremony pass or any unrelated baseline failure is independently reproduced and
  documented.

## Rollback

This is a code-only change with no schema or durable-state migration. Reverting the
commit restores the prior behavior. During rollback propagation, Throughput may
return the original 503 and the two remaining CLI consumers may again depend on the
ambient machine, so rollback is operationally safe but knowingly restores the
incident.

## Convergence record

The first implementation removed the Throughput subprocess and added the shared
runtime. Independent security, integration, and throughput-correctness reviews
then challenged the design. The converged revision additionally threads explicit
identity through the real `safe-merge` act path, validates Search cardinality,
uses timezone-aware day boundaries, rejects relative PATH entries, caches vault
resolution, and adds consumer-level behavioral tests. With those findings folded
in, all three review lenses returned no unresolved design objection.
