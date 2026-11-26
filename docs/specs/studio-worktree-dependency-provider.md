---
title: "Verified dependencies for Studio worktrees"
slug: "studio-worktree-dependency-provider"
author: "Echo"
parent-principle: "Notice + Solve Inefficiencies — Efficiency Is a Standing Search"
approved: true
approved-by: "Echo for dark CLI implementation after independent review"
review-convergence: "2026-11-25T14:05:40.915Z"
review-iterations: 3
review-completed-at: "2026-11-25T14:05:40.915Z"
review-report: "docs/specs/reports/studio-worktree-dependency-provider-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "error"
---

# Verified dependencies for Studio worktrees

Fresh worktrees repeatedly install the same dependencies or borrow a writable dependency tree. The existing creation command expects a working SQLite native binding before handing back a checkout. Provision the verified tree ahead of that check.

## Parent standard

Notice + Solve Inefficiencies — Efficiency Is a Standing Search. Worktree runtime readiness keeps a new checkout usable before it is handed to a session. The stewardship rollout replaces unnecessary installs while retaining its existing readiness checks.

## Proposed design

Add an opt-in macOS provider to the Instar worktree CLI. The agent-local worktree.verifiedDependencyStore boolean enables it, with absence treated as disabled. Respect explicit no-share. The canonical agent state directory contains a machine-local store with entries addressed by the pnpm lock hash and the Node ABI, OS and architecture. For the first release an entry attests to exact pnpm workspace and native build helper bytes, and to the root package manifest after removing only its version. A separate entry is needed for a different recipe under the same lock. The package-manager version, registry identity without credentials, toolchain identity, install and build flags, actual workspace manifests, lifecycle helpers, and workspace configuration are part of the seed receipt. The Studio starter recipe does not authorize project npmrc, pnpm hooks, patches, Git URL overrides, or linked or file-based dependencies. The steward may publish a separate verified recipe for one of these cases after it passes input pinning, credential-free config and staged confinement checks. Unrecognized inputs trigger a private install. Only approved publisher inputs can build a seed. The publisher runs with an allowlisted environment, empty user and system npm and pnpm config, a pinned toolchain path and explicit platform, optional-dependency and build options. It rejects any unrecognized configuration and records the sanitized recipe. A same-lock ambient-config difference must pass the rejection test. The normal worktree never executes a dependency install against that seed. The CLI does not construct or refresh a seed.

Build the seed from trusted canonical source using a frozen pnpm lock and a checkout-private virtual store. The machine steward publishes a receipt bound to a recursive inventory of bytes, modes, relative paths and symlink values, with a verified graph digest stored in the trusted agent configuration. Seed publication and use share a lock. The verifier checks seed and staged output against the pinned receipt, rejects special files, mounted descendants, absolute links, and broken, cyclic or escaping relative links. The provider forces copy-on-write per regular file, creates new directories and internal relative links, rejects shared inode identities, then uses Darwin exclusive rename relative to the validated checkout parent to publish at a genuinely absent target. The Studio provisions a verified, architecture-specific clone helper before rollout, with its digest pinned beside the seed. Checkout creation never builds or downloads it. Helper absence, mismatch or lack of APFS support is a clean miss. This trust model protects against accidental mutation and incomplete writes on one account. It assumes the user account and agent operator control plane retain custody of the pinned config. It does not claim isolation from a hostile process with authority to edit that config. Copy failures must not fall back to a writable link to the seed. Reuse the existing scoped filesystem guard for disposable staging cleanup. No migration or garbage collection runs inside checkout creation. Site workspace dependencies remain separately provisioned unless their links can be shown to stay inside their own copied tree.

## Decision points touched

- Enable verified seed use only by trusted machine config and only for share-enabled creation — invariant; basis: enumerable-domain; evidence: explicit no-share and absent feature flags retain the CLI's existing authority.
- Admit only a verified recipe, supported runtime and a confined relocatable graph — invariant; basis: irreversible-consequence; evidence: accepting a mismatched or escaping graph can execute incompatible code or expose shared dependencies to writes outside the checkout.
- Publish with exclusive rename and private file identities — invariant; basis: external-constraint; evidence: POSIX rename can replace a pre-existing empty directory and ordinary copy helpers may silently fall back to full copies.
- Bound provider work inside the manager's existing create lock — judgment-candidate with a finite parent operation deadline, progress-aware cancellation, cleanup of only the owned staging path, and the checkout manager as the arbiter.

## Provisioning outcomes

An absent feature flag or explicit no-share retains the existing provisioning semantics. An opted-in miss, or an operational clone failure with proven staging cleanup and no target, uses checkout-private npm ci with the same pinned runtime and the current checkout package-lock. An absent or invalid npm lock fails visibly on this fallback. A contested destination is a failed checkout, with no cleanup or replacement of the competing path. A seed or staging integrity failure fails visibly even when staging cleanup succeeds. The result is held if cleanup cannot be proven. Opted-in paths never fall back to writable sharing. After publication, SQLite or Husky failure leaves a failed checkout for inspection and never marks it ready or retries by overwriting its dependencies. Record disabled, verified clone, clean miss and failed hit in the normal result and ledger without reporting credentials.

## Multi-machine posture

machine-local-justification: hardware-bound-resource

The seed is physical APFS storage and depends on the executing machine runtime. No absolute store path or native seed is replicated. The checkout workflow uses the target machine's verified entry or proceeds with its normal local installation. Ledger records follow the existing worktree ledger replication policy and carry the machine ID, never a seed path.

## Verification and rollout

First run report-only and opt-in fixtures. The separate read-only steward preflight measures lookup and eligibility, keeps existing provisioning, and never writes into the dependency store. Disabling the Studio flag restores the existing default for future worktrees. Test the CLI entry with flag disabled, a hit, a miss, explicit no-share, input and runtime mismatch, out-of-tree dependency links, clone failure, and staged rename failure. Run a native SQLite query and focused tests in a real Studio checkout; demonstrate a write in its dependency tree leaves the seed and a second checkout unchanged. Measure checkout accounting separately from actual APFS volume consumption, since summed file allocations count cloned blocks more than once. Time the full verified hit, including the seed and staging digest passes, against private installation on the Studio during ordinary checkout contention. Enable the Studio flag only after the verified hit improves that path, fits within the parent timeout, and has a measured storage benefit. Candidate promotion proceeds from disposable test checkout to the Studio development agent. Broader eligibility waits for equivalent host isolation, runtime and storage evidence. Server topic checkout and legacy build helper integration are outside the initial release.


## Maturation plan

- **test-agent-live:** Use the ordinary checkout command against a disposable repository, with fixture seed, storage accounting, fallback and readiness checks.
- **dev-agent-live:** Enable the agent-local flag on Studio after the disposable link-isolation, contention and physical storage checks pass. The steward can disable it immediately through the same config.
- **fleet:** Consider default-on for development-role macOS hosts that can publish and verify a compatible APFS seed. Ordinary fleet hosts retain the existing path until their supported host profile passes the same installation and isolation checks.
- **graduation criterion:** The same manager path produces dependency isolation, native readiness and lower physical consumption under representative checkout activity. Separate checkout entry points graduate only after equivalent wiring proof.
- **dark-window:** From candidate deployment until the representative checkout verification and before/after storage receipt are both available.
- **ladder:** Disposable fixture, Studio development rollout, then eligible fleet hosts.
