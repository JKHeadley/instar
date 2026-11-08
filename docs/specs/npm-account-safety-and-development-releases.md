---
title: Account lockout prevention and development releases during npm holds
slug: npm-account-safety-and-development-releases
author: echo
parent-principle: "The Person Decides; the Agent Does the Rest"
approved: true
lessons-engaged: "P1/P2/P3/P5/P12/P15/P20/P21/P24; L4/L5/L7/L9/L10/L12; B2/B3/B10/B20/B28/B30 — shared migration, explicit authority, complete evidence, real installation and bounded recovery"
approval-source: "Justin's topic 10000002397 instruction: build both and merge when green; only constitution files need Justin"
review-convergence: "2026-11-08T00:26:44.282Z"
review-iterations: 3
review-completed-at: "2026-11-08T00:26:44.282Z"
review-report: "docs/specs/reports/npm-account-safety-and-development-releases-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "codex-cli:gpt-6-astra attempted twice; 180s and 120s timeouts; internal independent final review DESIGN0 PRECISION0"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

## Problem statement

An agent handed npm token creation to Justin without offering to perform it. When corrected, it used a stored recovery code to avoid a browser restriction, missed a suspension warning because it read only 300 characters, and caused a 72-hour publishing hold. npm publishing from GitHub failed too. Local emergency mitigations and direct installs were reported in topic 130715, but the install base needs durable protection and a repeatable development distribution path.

## Proposed design

At the actual normal Chrome JavaScript boundary, inspect the full current top-level visible page before arbitrary code execution. The TypeScript-authored browser policy emits an observation when it sees a recovery-code form or known suspension/lockout warning. The first flagged invocation returns an advisory without executing caller code; it has no terminal veto. The context-rich session agent is the authority: read every page chunk, compare its page fingerprint, consider the actual conversation and authorization, then explicitly acknowledge the exact current fingerprint with a nonempty review reason to continue unchanged when appropriate. A changed page requires fresh review. This follows the existing Telegram advisory pattern and the canonical Standards Registry, rather than the broader outdated irreversible-action exception in docs/signal-vs-authority.md.

Fixed read-page mode always remains available and returns explicit chunks with page fingerprints. Shared account guidance requires offering to do safe account tasks, reading whole pages and respecting browser restrictions instead of bypassing them through account recovery. Ordinary sign-in pages remain available for automated password, OAuth, token and passkey use. Recovery/backup codes require specific informed operator approval for the exact account/action/consequences; no self-minted approval file establishes that authority. The acknowledgment is the session agent's reviewed decision, not evidence of operator authorization. Install and migrate guidance for existing agents. This protects the supported workflow against accidental unreviewed actions, not arbitrary external browser programs or a deliberately dishonest session.

Add an opt-in GitHub Actions development-release workflow. Build current main on macOS with universal native assets, pack without publishing, and attach a manifest and tarball to an immutable dev-SHA GitHub prerelease. Require clean source and do not alter npm versions/tags or consume upgrade notes. The manifest records repository, full source SHA, a development version, tarball basename and SHA-512. Trust comes from the authenticated repository download; checksum is corruption detection, not a signature.

An explicit local install command validates manifest and digest, copies the artifact to a private snapshot, and invokes the same UpdateChecker candidate/native-probe/promotion/rollback/migration path used for npm updates. No independent installation implementation. Require source package version to equal read-only npm latest; use the target agent Node runtime and record its actual prior shadow version. Rollback points to the prior published stable base, never an unpublished dev cut. Bound package-list capture at 64 MiB because the real npm pack JSON exceeds 1 MiB. Failure retains active install. Installation is per explicit agent home, with no concurrent updater and a normal session-aware restart afterward. No forced session termination. The development version retains the last stable patch so the next npm patch automatically supersedes it. Normal users keep the stable channel. No npm-account mutation or retry is necessary during the hold.

## Decision points touched

- Account browser execution — judgment-candidate; floor: first flagged call emits an observation without execution; fixed read-only inspection always available; arbiter: session agent with whole page and live conversation; fallback: no acknowledgment means no execution. Exact current fingerprint plus explicit review reason permits proceeding unchanged. The detector never has final veto. Never infer mutation safety from arbitrary JavaScript text.
- Release distribution — invariant; basis: enumerable-domain; evidence: only explicit pack/install commands and one trusted repository are admitted. Explicit operator/developer opt-in. No fallback to arbitrary URLs or alternate registry.
- Artifact admission — invariant; basis: enumerable-domain; evidence: checksum, version, source SHA and basename have exact structural contracts. Exact structural/hash/version checks. Existing candidate validation and promotion remain the single installation authority.
- Normal updater — invariant; basis: external-constraint; evidence: a development base must equal the published npm stable version so the next patch supersedes it. Unchanged npm version discovery and stable-channel selection. Explicit development install is a separate invocation of the same execution path.

## State versus symbol and fixed limits

The browser reads full top-level visible page text and visible recovery controls, not a cropped preview. This certifies that known account-lockout warnings and recovery forms surface a review advisory before caller JS executes through this wrapper; hidden text, cross-origin frames, shadow roots and novel wording remain outside its certainty. A normal auth page with a hidden recovery dialog is a nonmatching counterexample and must remain usable. Missing page body is an unreadable-state error, never an implicit reviewed decision. Read-page chunks use a content fingerprint to reject mixed-page reads procedurally. 6000 characters is an output pagination size, never an approval threshold; every chunk remains accessible. SHA-512 equality certifies byte identity only. It does not certify trusted authorship or safe package code. A successful native and CLI probe certifies candidate startup, not all future agent behavior. Production-health confirmation happens after session-aware restart. The 64 MiB JSON buffer is a resource bound, chosen above the observed 1.75 MiB listing; overflow fails the build before distribution rather than silently truncating a manifest.

## Verification

Executable browser tests cover risky pages, ordinary authentication, read chunks, generic JS and the installed driver. Migration/awareness tests cover existing and new agents. Artifact tests prove corrupt input cannot invoke npm; immutable bytes are installed; native probes and promotion execute; the next stable patch wins. CLI/workflow contracts cover source pinning, clean build, no npm publishing, and package manifest. Full repository checks and green PR CI are required before safe merge.

## Multi-machine posture

Code and guidance replicate via package updates and existing migration paths. Development artifacts are portable across machines and downloaded from GitHub; installation is machine-local BY DESIGN because each machine has its own native dependencies and shadow install. machine-local-justification: hardware-bound-resource — native dependencies and each machine’s runnable shadow installation must match its local Node runtime.

No new fleet state, URLs to a local machine, status routes, automatic notices or one-voice sender are introduced. Explicit deployment receipts identify each target; offline targets can install the same immutable artifact later.

## Risks and rollback

Page detection can miss novel provider wording or over-match a warning. It is a narrow safety floor with supported-driver tests, backed by full-page workflow guidance. The browser remains useful for ordinary account automation and an explicit reviewed continuation remains available on advisory pages. GitHub availability and public npm dependency installation are prerequisites for the development lane. A malicious trusted artifact can execute code; arbitrary manifests are never trusted. Revert undoes the feature; installed dev builds return to normal stable on the next patch. Promotion retains existing recovery behavior and stores rollback state.

## Open questions

*(none)*

## Maturation plan

- **dark-window:** No automatic account action or release rollout is introduced. Review remains conversational; development distribution is an explicit command.
- **test-agent-live:** Installed-wrapper fixture exercises the full-page advisory, complete chunks, reviewed continuation and changed-page review; real offline package installation proves native SQLite, promotion and migrations.
- **dev-agent-live:** After merge, exercise the GitHub development-release workflow for the exact merged source and verify its immutable manifest/package. Existing direct-install mitigations reported in topic 130715 remain independently identifiable.
- **fleet:** Normal package updates install the shared policy and helper on existing/new agents. Development artifacts stay an explicit per-agent opt-in; no automatic channel switch or fleet account action.
- **graduation criterion:** Browser advisory/read/ack regressions, migration/new-agent lifecycle tests and release installation tests green; GitHub publishes an installable dev artifact while npm publishing stays unused.
- **ladder:** not applicable - explicit commands and reviewed per-action browser continuation
