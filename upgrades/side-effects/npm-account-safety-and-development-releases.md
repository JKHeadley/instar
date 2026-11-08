# Side-Effects Review — Account safety and npm-independent development updates

Version / slug: npm-account-safety-and-development-releases
Date: 2026-11-07
Author: Echo
Second-pass reviewers: review_safety and review_release (independent agents)

## Summary of the change

Adds TypeScript-authored normal-Chrome account-page safety, fixed complete-read mode and context-rich session-agent review acknowledgment, shared account-action guidance delivered to new and existing agents, and an opt-in GitHub development-release workflow. Explicit artifact installation reuses UpdateChecker's candidate/native/probe/promotion/migration pipeline. No constitution files change.

## Decision-point inventory

- Account preflight — add: emit an advisory on known recovery/hold pages; current-page review acknowledgment by the session agent permits unchanged continuation; fixed read-only mode remains available.
- Browser script installation and guidance migration — modify: existing refresh/install consumers receive the same policy and helper.
- Development package admission — add: clean immutable source, published stable base, exact manifest/digest/version, explicit agent target.
- Installation execution — pass-through: reuse existing native probe, atomic promotion, recovery backup and migrations; target runtime selected for external installer.
- Rollback metadata — modify: unpublished development cuts map to their published stable base; actual prior dev version retained as evidence.

## 1. Over-block

A known recovery/hold page causes a review interruption, not a final refusal. Benign inspection and legitimate authorized actions can continue after the context-rich agent reads the whole page and records its review against the exact current fingerprint. Fixed read-page works immediately. Hidden recovery dialogs do not interrupt ordinary sign-ins. Advisory wording may over-match a help page; explicit reviewed continuation resolves that without changing a registry policy.

## 2. Under-block

Novel warning language, shadow roots, iframes and other OS/browser drivers are not universally inspected. A deliberate shell bypass or an asynchronous script that navigates then acts is not sandboxed. Shared policy forbids bypass and requires a fresh complete read before each action. This is bounded prevention of the observed incident class, never a promise of impossible-to-trigger provider lockouts. GitHub manifests must come from the authenticated trusted repository; a checksum alone does not establish provenance.

## 3. Level-of-abstraction fit

The supported normal-Chrome execution boundary sees the full visible top-level DOM before running caller code. The decision is authored in TypeScript and installed unchanged as browser JavaScript. Shared policy belongs in scaffold, migration and skill guidance; it propagates through existing installers. Temporary updates belong in release tooling and the existing update executor, not an alternate parallel promotion implementation.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md), superseded on exception scope by the canonical [Standards Registry](../../docs/STANDARDS-REGISTRY.md).
Initial design used the legacy document's irreversible-action exception. Final independent review found the canonical registry permits only the named emergency-stop exception, so that design was rejected and revised. The matcher now emits observations; it has no final veto. The session agent, with the complete page and live conversation, owns judgment and can continue unchanged with an explicit reason and current-page fingerprint. Missing review does not execute caller code; missing/unreadable state is not treated as authorization. Acknowledgment is not evidence of operator consent for recovery. Manifest/digest/shape checks remain structural invariants, not intent judgments.

## 4b. Judgment-point check

Account action is a judgment point: the matcher informs, the context-rich session agent decides. The mechanical floor keeps first advisory calls non-mutating and requires exact current-page review plus a reason to continue; fixed read-only mode remains available. Pack/install are explicit one-shot commands; identity/digest/manifest validation is enumerable. Output chunk size paginates data and does not authorize actions. Package JSON capture and CLI migration output are bounded at 64 MiB and fail loudly on overflow. A full-package rehearsal found migration output exceeded the old 1 MiB default; a red/green real-install regression now verifies direct migration completion with 1.2 MiB JSON, without falling back.

## 5. Interactions

Shadowing: preflight runs before caller evaluation, including mainworld's existing chrome-js funnel. Normal origin/profile checks remain.
Double-fire: no recurring sender or new monitor. Read-only calls never evaluate caller code; advisory acknowledgement is not an approval credential.
Races: DOM preflight and caller eval run in the same task; chunk fingerprint detects page changes procedurally. Installation requires no other update active for that target; existing updater concurrency assumptions are retained. Artifact snapshot prevents a source-file change between verification and npm install.
Feedback loops: no new automatic retries/controllers. Existing bounded candidate retry remains.

## 6. External surfaces

GitHub receives opt-in prerelease artifacts, not npm account writes. No new credential is requested or stored. The developer installer is a power-user command for development/test agents; normal users remain on stable and no operator form is added. Recovery still requires actual specific informed operator approval; the page acknowledgment cannot manufacture that authority. Source SHA, version and checksum appear in manifest; no secrets or account codes enter it. Public dependency installation remains necessary.

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard, approval-page or grant-form markup changes.

## 7. Multi-machine posture

Policy/code are replicated through the existing package/scaffold/migration path. Native shadow installation is machine-local BY DESIGN because each machine's runtime/native dependencies and process installation are hardware-bound. GitHub artifacts and URLs survive machine boundaries; explicit target homes avoid accidental fleet rollout. No new user-facing automatic notices, durable agent coordination state, /status, /health, /capabilities or /channels answers are added. Runtime health remains the existing local health surface after restart. State is not stranded on topic transfer.

## 8. Rollback cost

Revert undoes code and policy; helper/guidance migration must be refreshed after downgrade if desired. Candidate failures leave active install runnable. Existing update rollback installs the prior published stable base, even after multiple dev cuts. Registry installation availability is still required. The next official patch is newer because dev cuts retain the verified current stable patch. Source must match npm latest before packaging; no accidental future base can strand stable return.

## 9. Class closure

No agent-authored-artifact defect — not applicable. The triggering defect was an operational account action on truncated evidence, not an agent-authored prompt/parser/guard artifact. The added account action advisory/review contract is covered by executable supported-driver regression tests; it is not represented as universal prevention.
`defectClass: unbounded-self-action`, `closure: n/a`, `reason: one-shot user-driven pack/install and per-call browser validation, not a self-triggered controller`. No new feedback-loop emit is introduced.

## Second-pass review

review_safety: Final consolidated review CLEAN, DESIGN 0 / PRECISION 0 after canonical-registry correction; convergence recommended. The detector is signal-only and reviewed continuation belongs to the session agent. Installed-wrapper account tests passed (26 targeted assertions including full reads, ordinary auth, current review, stale review and mainworld forwarding).
review_release: Concur after fixes for real npm pack output size, published stable base, target runtime, target prior version and stable rollback normalization. Real offline npm/native integration test passed (1/1), including migration.
External codex-cli gpt-6-astra review attempted twice (180s and 120s), both timed out; disclosed as degraded-all-rounds, never concurrence.

**Reviewer:** independent general-purpose subagent (Claude Opus 5.5, fresh context), 2026-11-08, on head 8a077eff17 for `.github/workflows/development-release.yml` and `scripts/development-release.mjs`.

review_workflow: CONCUR, no blocking findings. Confirmed: the workflow runs only when started by hand (`workflow_dispatch`), takes no inputs, and so has no script-injection path. It uses only `github.token` as `GH_TOKEN`, with no npm token and no `npm publish`. It creates prerelease tags `dev-<sha>` that are never replaced and never marked latest. The SHA-512 is computed over the exact tarball that is uploaded. Applied from this review: `persist-credentials: false` on checkout, so `npm ci` install scripts cannot reuse the write token. Not blocking, accepted for now: actions are pinned by tag as elsewhere in the repo; a partially uploaded release is not repaired on re-run; a dev version is invalid semver if the SHA prefix is all digits with a leading 0, about a 0.04% chance, and the pack step then fails safely; the job lockfile is unsigned in CI, so it runs in the present-untrusted mode; the install step checks file integrity, not where the file came from.
