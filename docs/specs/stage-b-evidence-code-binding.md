---
title: "Stage-B release evidence binds to the certified code, not the version number"
slug: "stage-b-evidence-code-binding"
author: "Echo"
parent-principle: "Verify the State, Not Its Symbol"
review-convergence: "2026-09-04T03:06:31Z"
review-iterations: 5
approved: true
approved-by: "Justin, topic 52075, 2026-09-03 — explicit pre-approval of this exact recommendation ('you have my approval for whatever you need'), under the operator-decided review model in which technical correctness is the agent's responsibility"
---

# Stage-B release evidence binds to the certified module set, not the version number

**Constitutional parent: "Verify the State, Not Its Symbol" (docs/STANDARDS-REGISTRY.md, The
Substrate).** The version number is a symbol that stood for "the code the canary certified"; it
diverged from that state after one release and froze publishing. This change verifies the
declared subject itself — the certified modules' bytes — instead of the symbol. Secondary fit:
"Close the Loop" (a release gate that can never pass again is an abandoned loop) and "The User
Experience Is the Product" (a frozen release pipeline withholds every user-facing fix).

## Problem statement

The Stage-B publish gate (`scripts/verify-codex-stage-b-release-evidence.mjs` →
`verifyBundledStageBReleaseEvidence`) verifies the Echo-signed two-hour / fifty-delivery RC
canary artifact by constructing bindings from the CURRENT build: `packageVersion` must equal
`package.json`'s version and `gitCommit` must equal `package:<that version>`. The shipped
artifact was bound to `1.3.1219`. That release published; every later release fails
`artifact-binding-mismatch`. Binding evidence to a version string can pass exactly once, so the
gate as built is a permanent release freeze one release after it ships — regardless of whether
the code the canary certified changed. The fleet has been unable to receive ANY fix since
2026-09-02 (first blocked publish: run 33658559565). The operator approved rebinding the
evidence to the Stage-B code on 2026-09-03 (topic 52075: "you have my approval for whatever you
need", following two explicit descriptions of this exact recommendation).

## Proposed design

**The invariant the spec keeps:** a release may ship Stage-B enabled only while the canary's
DECLARED subject — the certified module set, five named Stage-B sources, listed in a reviewed
manifest — is byte-identical to what the approved canary ran against. The subject is
deliberately the declared set, not the whole build: see Honest limits.
A change to that implementation blocks publishing until a fresh approved canary exists. The
version number was a proxy for "the code changed"; this spec replaces the proxy with the real
thing.

**1. A git-tracked certified-set manifest** at `src/data/stageBCertifiedSet.ts` (ships in the
package; `src/data` is in `package.json` `files`):

- `roots`: the five Stage-B sources the canary drove:
  `src/core/InboundDeliveryStore.ts`, `src/core/CodexDeliveryObserver.ts`,
  `src/core/CodexComposerAdapter.ts`, `src/core/CodexLifecycleProductionComposition.ts`,
  `src/core/StageBStartupReadiness.ts`.
- `certified`: the fingerprinted set — the roots plus every member of their transitive
  relative-import closure that is not explicitly excluded.
- `excluded`: closure members deliberately OUTSIDE the fingerprint, EACH with a written
  reason (measured closure today: 40 files; the exclusions are the ~30 cross-cutting
  utilities — the shared types module, the secret store, the safe executors, the tone gate,
  redaction, semaphores — which change routinely for reasons unrelated to Codex delivery and
  are certified by their own suites; and the gate file itself, which is release policy the
  canary never exercises, so binding it would force irrelevant two-hour canaries for
  gate-policy fixes, including this one). **The cut is explicit and fail-closed, never
  silent:** the tool recomputes the closure on every check, and a closure member that is
  neither `certified` nor `excluded` — a NEW import added to any certified file — FAILS the
  check until a human classifies it, with a reason, in a reviewed diff. Nothing can drift out
  of coverage without leaving a written record.
- `fingerprint`: sha256 over the certified files' bytes (sorted by path, each contribution
  `sha256(path) + sha256(content)`), computed at binding time.
- `artifactDigest`: sha256 over the CANONICAL bytes of the exact signed artifact this
  fingerprint vouches for: `canonicalStageBRcArtifact(unsigned) + "\n" + signature`. The
  existing `JSON.stringify` digest is property-order-sensitive; the canonical form is already
  what the signature covers, so the digest is stable across construction order.
- `boundAt`, `boundBy`, `note`: provenance prose.

Verified fact grounding the initial manifest: `git diff 92a21075d..1b46533a7 --stat` over the
five certified files is EMPTY — the canary's subject is byte-identical since the evidence
commit, so rebinding the existing approved artifact is honest, and no fresh canary is needed.

**2. One shared shipped-evidence verifier, used by BOTH release and runtime.** A new
`verifyShippedStageBEvidence(shipped)` verifies, in order: evidence present and well-formed;
artifact shape, signature (against the shipped public key), canary duration, delivery
threshold, case matrix, zero failures, reviewer approval — reused from
`StageBActivationGate.verifyArtifact` with bindings taking `packageVersion`, `gitCommit`, and
`echoMachineId` from the artifact itself (version and commit become historical provenance of
where the canary ran; the machine-id comparison was already artifact-sourced in today's code)
while `configSha256` REMAINS a real comparison against the current build's
`stageBConfigSha256({ledgerObserverEnabled: true})` — the behavioral-config binding keeps its
teeth; then the NEW binding: the canonical artifact digest must equal the manifest's
`artifactDigest`. Mismatch → `artifact-binding-mismatch`. `verifyBundledStageBReleaseEvidence`
delegates to it (its `packageVersion` parameter becomes unused but stays for call-site
compatibility, documented). **The runtime fleet-activation path is fixed the same way:**
`resolveStageBProductionActivation`'s shipped-evidence branch today constructs bindings from
the CURRENT `input.packageVersion`/`input.gitCommit`, so once publishing unblocks, every
installed later release would reject the shipped artifact and Stage B would silently stay dark
fleet-wide; that branch now routes through `verifyShippedStageBEvidence` (the manifest ships in
the package, compiled from `src/data`), keeping the machine-LOCAL candidate-canary path's
exact-build bindings untouched. One documented seam: the `shippedEvidence`
INJECTION parameter (tests and release tooling only — a source-level test pins
that no production caller passes it) keeps every shape, signature, threshold,
and config check but cannot match a manifest bound to the real bundled
artifact, so the digest linkage applies to the package-bundled path, which is
every production caller.

**3. The publish gate gains the source-drift check.** A new script
`scripts/stage-b-certified-fingerprint.mjs` recomputes the closure and the fingerprint
(`--check`: exit 1 naming per-file drift, any unclassified closure member, any excluded entry
missing its reason, and any certified/excluded entry that no longer exists). Its `--write` mode structurally refuses
the dishonest rebind: when the computed fingerprint differs from the manifest's, it refuses
unless the bundled artifact's canonical digest ALSO differs from the manifest's
`artifactDigest` — so old evidence can never be re-stamped onto changed code; changed code
requires NEW embedded evidence (a fresh canary) before the manifest can move. The initial
binding (no manifest yet) is the one exception, and it binds to the current evidence. The publish-time verifier
(`verify-codex-stage-b-release-evidence.mjs`) runs BOTH: the shared function above AND
`--check` with the repo sources. Drift message: "Stage-B certified source changed since the
approved canary: <files>. Run and approve a fresh canary, then rebind." Runtime consumers
(`PostUpdateMigrator`, `init`) call only the shared function: an installed package carries no
`src` tree to fingerprint, and it does not need to — the publish gate already refused to ship
any package whose sources drifted from the manifest, so bundled evidence + manifest digest
agreement is the installed-package invariant.

**4. Drift is caught at push time, not only at publish.** The verifier runs via
`prepublishOnly`, i.e. only when the publish workflow ships — after merge. This spec adds
`stage-b-certified-fingerprint.mjs --check` to the pre-push gate's cheap checks so an agent
discovers drift at push time rather than at the (post-merge) publish.

## Honest limits, stated rather than implied away

- **The fingerprint has no adversarial value, and neither did the version binding.** The
  manifest, the fingerprint script, the verifier, the bundled evidence, and its public key are
  all editable in one ordinary PR in this repository — exactly as today's verifier is. The
  binding exists to catch HONEST drift (a maintainer changing certified code without realizing
  a canary is owed), not to stop a malicious writer; review of the diff is the only defense at
  that layer, unchanged from today.
- **The excluded closure members can still change certified behavior without forcing a
  canary.** Binding the full 40-file closure would recreate the exact freeze this spec removes
  (it includes the shared types module and other universally-churning utilities), so the cut
  exists — but it is enumerated per file with a written reason, recomputed on every check, and
  fail-closed for anything new. What is genuinely not covered: a behavior change INSIDE an
  excluded utility. That residue is accepted and visible in the manifest itself.
- **Publish-path integrity is unchanged.** The check rides `prepublishOnly` inside the publish
  workflow; a hand-rolled publish that bypasses lifecycle scripts bypasses today's gate
  identically. Out of scope here.

## What this deliberately does not change

- `StageBActivationGate.verifyArtifact` and the machine-local runtime activation path
  (`resolveStageBProductionActivation`, `state/codex-stage-b-rc.json`) keep today's exact-build
  bindings: a LOCAL candidate canary is bound to the build it ran on, which is correct there.
- The artifact schema stays v1; the existing Echo signature stays valid; no re-signing.
- The two-hour / fifty-delivery / case-matrix / zero-failure / approved-review thresholds are
  untouched.

## Decision points touched

One block gate is modified, none added or removed: the Stage-B publish gate keeps blocking
authority, with its binding predicate corrected from "version equality" (deterministic,
wrong after one release) to "certified-source fingerprint equality" (deterministic, tracks the
actual subject). Fail direction remains closed for publishing. No LLM in the loop, exact-match
territory (secrets/money/irreversible-release class).

## Open questions

None requiring the operator: the operator approved the direction explicitly on 2026-09-03
(topic 52075). The certified-set membership (gate excluded) is the one judgment call, argued
above and reviewable in the PR.
