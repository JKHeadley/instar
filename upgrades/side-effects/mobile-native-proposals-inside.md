# Side-Effects Review — Native Proposals and How I'm doing inside screens

**Version / slug:** `mobile-native-proposals-inside`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `cross-model codex-cli and clean-door claude-code reviewers (see below)`

## Summary of the change

Two read-only routes for the Instar iPhone app, owner phones (device-signed) or the bearer token only: `GET /mobile/proposals` and `GET /mobile/inside`. New module `src/server/mobileProposalsInsideRoutes.ts`, two `DEVICE_ALLOWLIST` entries, `loadAllProposals` exported, a CapabilityIndex entry and a CLAUDE.md bullet with its migration. Tier 2 because it widens device-key read access.

## Decision-point inventory

- `DEVICE_ALLOWLIST` — add — two exact-path GET rules, `ownerOnly`, a shared own bucket.
- `ownerOrBearer` — reuse.
- Field allowlists, path replacement, peer rebuild — add — a fixed redaction contract.

## 1. Over-block

An MSP phone cannot read either screen; that is the owner-only default. A peer whose answer fails the shape check is listed as not answering; one with a section missing its numbers still shows, with that section unavailable. Either way the screen under-claims, which is the intended direction.

## 2. Under-block

Free text can hold repo-relative file names, and a path form outside the replaced prefixes; the scrub is best effort, and the owner reads the same text in the console. A stolen owner phone that passes the device check can read these summaries, like the other owner reads.

## 3. Level-of-abstraction fit

Same layer as the merged mobile read modules. The words duplicate `inside-model.js`, because the server cannot import the console's view model into a route without coupling them; a parity test pins the kind, insight-status and verdict tables (the others are not exported by the console model).

## 4. Signal vs authority compliance

No blocking authority is added, no detector, no LLM. The allowlist and owner checks are identity authorization, not judgment. `docs/signal-vs-authority.md` does not apply beyond that.

## 5. Interactions

Shares the `peerSummaries` helper and the 15 s single-flight pattern. Own device bucket, so it does not eat the other screens' budget. A test fixes the named owner-only set. The raw routes are unchanged.

## 6. External surfaces

Two new read paths; the app shows "update the agent" on older servers. Peers receive two extra bearer reads, at most once per 15 s per route while a phone is reading. No LLM spend. No notices.

## 7. Multi-machine posture

Both proxied-on-read through `?scope=local`, each row or group naming its machine; missing machines named. No durable state, no generated URLs.

## 8. Rollback cost

Revert. No data, config or migration to repair; the CLAUDE.md bullet stays harmlessly until the next template refresh.

## Second-pass review (if required)

**Reviewer:** cross-model codex-cli gpt-6-astra (6 rounds) and clean-door claude-code (2 rounds), fresh context, reading the spec and module
**Independent read of the artifact: minor issues, no blocker**

Each round's findings were applied with tests; see `docs/specs/reports/mobile-native-proposals-inside-convergence.md`. Codex round 6 and the first clean-door read of this artifact raised design points, all fixed. The last clean-door read returned MINOR ISSUES: dismissed and promoted are per-machine sums, the headline ignores overdue and failed-review rows, and peers exchange display words rather than codes. The first two are stated in the spec as deliberate, matching the console. The third fails safe ("can't tell") and is left as it is.
