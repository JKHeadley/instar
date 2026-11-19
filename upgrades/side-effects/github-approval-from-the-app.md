# Side-Effects Review — Approve a code-owner pull request from the owner's phone, verified on GitHub

**Version / slug:** `github-approval-from-the-app`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Spec: `docs/specs/github-approval-from-the-app.md` (converged in 6 rounds with codex-cli each round, approved by echo). Tier 2: it records a durable approval in the owner's name on GitHub. About 15 files, roughly 1,400 lines including tests and the spec. Effort: 6 spec rounds (the Tier-2 cap), first commit attempt.

Part A (always on): the merge watcher's `code-owner-review` snapshot entries carry the PR `title` and every code-owned file (`ownerFiles`); `GET /green-pr-automerge` adds `repo` and `ownerApproval {available, reason}`; the Development page builds GitHub links from the watcher's repository (no more "GitHub links are off" when the slow Pace read fails); the `shipping-approvals` Needs-you rows and `GET /needs` / `GET /mobile/needs` items carry `pr`, `githubUrl`, `prTitle`, `prSummary`, `headSha`, `approveAvailable`.

Part B (off unless `github.ownerApproval.enabled`): `src/core/GithubOwnerApproval.ts` + `scripts/github-owner-approve.mjs`, and owner-phone routes `POST /mobile/permissions/challenge {action:'github-approval', target:'<n>', headSha}`, `POST /mobile/github/approvals/:pr/approve {headSha, challenge, presenceSig}`, `GET /mobile/github/approvals/:pr[?attempt=]`. The owner's Face ID tap makes the agent record the owner's approving review in the owner's signed-in GitHub browser profile; GitHub's reviews API decides success. There is no console approval route.

## Decision-point inventory

- Owner-phone-only gate for the approval (existing `writeGate` + presence proof) — **add** (new action kind on the existing gate).
- Head binding (challenge stores head; approve must match; live head must match) — **add**.
- Scope: agent's own PR whose changed files the owner owns under base-commit CODEOWNERS — **add**.
- Success verdict = new owner review APPROVED at that head, read from GitHub — **add**.
- HOLD on an approval at another head — **add** (consumes the watcher's existing `applyHold`).
- Availability (switch, profile, vault, code-owner login, pinned playwright-core) — **add**.

---

## 1. Over-block

- A legitimate approval is refused when the PR moved after the row was drawn (`head-changed`): intended; the owner looks again. The row refreshes on the watcher's next tick (up to 10 minutes) — the 409 carries the current head and title so the app can refresh sooner.
- A CODEOWNERS file using `**`, `?`, `[`, `!` or escapes is refused whole (`codeowners-unreadable`): today's file uses two literal paths, so nothing is refused now; the owner still has the GitHub link.
- A PR the agent did not open (`not-agent-pr`) is refused: intended (the HOLD must be applicable).
- An earlier attempt that cannot yet be settled blocks a new tap (`approval-unsettled`) until GitHub answers: conservative by design.

## 2. Under-block

- The browser click cannot pass GitHub an explicit `commit_id`. A sub-second race remains between the script's final head read and the click. Covered by the HOLD (retried once, the owner told plainly if it fails), by a new head needing its own checks before any merge, and by the switch staying off until the live race proof (spec Acceptance 8b) passes. Accepted at the spec-review cap and named in the convergence report.
- The agent already holds the owner's vault credentials; this gate stops accidents and replays, not a hijacked agent (stated in the spec's Security section).

## 3. Level-of-abstraction fit

The owner proof reuses the existing owner-phone write gate and challenge store (`mobilePermissionsRoutes.ts`), the same layer as account sign-in and session moves. The approval mechanics live in one service module; the HOLD reuses the merge watcher's own `applyHold` and ownership read (`holdEligible`), so there is no parallel ownership rule. The SEC-018 pending-card mechanism was considered and not used: it serves agent-initiated handlers, is off by default, and the app build session already codes against this route.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`. The gates added are deterministic checks guarding an irreversible external action (a durable approval under the owner's name), the case the principle explicitly allows: exact head equality, CODEOWNERS ownership, owner-phone presence. No brittle heuristic holds blocking authority over judgment. The Needs-you fields are signals only.

## 4b. Judgment-point check (Judgment Within Floors standard)

The one judgment-candidate is the 120-second approver deadline; its floor is the verification read, which decides the answer whatever happens, so the deadline bounds only latency. All other points are invariants with basis + evidence in the spec's Decision points section.

## 5. Interactions

- `applyHold` is called only on `approved-at-other-head`; it is the same call the `/green-pr-automerge/hold` route makes.
- The approver uses the owner's browser profile directory; a hand-run or MCP browser holding the same profile makes the script answer `profile-busy` (Chrome's own lock). The browser MCP seat lease guards a different directory.
- `GET /green-pr-automerge` now calls `availability()` (cached 60 s; reads files and the vault, no network). On a fleet agent with the switch off it returns at the first check.
- PR #3453 also edits `mobilePermissionsRoutes.ts` (identity piece 3a); the edits are in different functions.

## 6. External surfaces

- GitHub: a new approving review by the owner's account, only on the owner's Face ID tap, only on the agent's own code-owner PRs, only when switched on. Reads use the agent's own `gh`.
- The phone apps: additive needs fields; new routes the app build session codes against (contract confirmed with it: signed line `github-approval <n>`, head required at the challenge, 202 + polling).
- Persistent state: `state/github-owner-approval-runs.json` (attempts, kept an hour), `logs/github-owner-approvals.jsonl` (rotated audit, metadata only), `<profile>.approval.lock`.
- **Operator surface (Mobile-Complete):** the action is phone-completable by construction (Face ID in the app). The console shows the GitHub link and how to approve.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes: the needs row opens the PR sheet whose primary button is "Open on GitHub ↗"; the "How to approve" line says approve there or with Face ID in the app.
2. **Zero raw internals as primary content?** Yes: title and plain "It changes <files>, which only you can approve"; the commit stays on the existing muted mono line.
3. **Destructive actions de-emphasized?** Yes: unchanged (Hold stays a quiet button below the primary link).
4. **Plain language + phone width?** Yes: plain sentences, no new layout; the existing sheet already stacks at phone width.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Part A rows: machine-local (the watcher's lease-holder snapshot), the existing declared posture of `shipping-approvals`.
- Part B: machine-local BY DESIGN, `physical-credential-locality`: the owner's signed-in GitHub browser profile is a directory on one disk. Its precheck is live (GitHub reads, base-commit CODEOWNERS), so it works whichever machine holds the merge lease. A machine without the profile answers `available: false` with a plain reason and its rows carry the link only.
- Notices: none sent; the phone's answer is the notice. Durable state: per machine, with the action. URLs: GitHub URLs, valid everywhere.
- Status surfaces: `GET /green-pr-automerge` gains `repo` and `ownerApproval`; `ownerApproval` is this machine's answer (it names why when not available here).

## 8. Rollback cost

Part B: set `github.ownerApproval.enabled: false` (the default): availability false, routes 503, rows link-only. Part A: additive fields; reverting the PR removes them. No migration; the runs file and audit log are harmless if left.

## Conclusion

The review reshaped the design substantially (console PIN route dropped, async answer, live owner-path scope, head bound to the challenge, HOLD, durable attempts and orphan cleanup). Clear to ship with Part B dark; switching it on for Echo waits on the live throwaway-repository proof.

## Second-pass review (if required)

**Reviewer:** independent subagent (2026-11-19)
**Independent read of the artifact: concur**

Concur with the review: approval needs the owner's phone with Face ID and has no bearer or PIN path; the head is bound to the challenge and checked live before the click; secrets go only to the script's stdin with a stripped environment; success needs a new owner review at that head; an approval elsewhere triggers a HOLD. Noted: the bearer-readable GET returns metadata only, and reading it can settle an interrupted run (HOLD or killing a process group that is still the approver script), both conservative. Suggested tightening: Face ID signs only `github-approval <n>`; adding the head to the signed line would bind the proof to the commit. Not taken now because the line is the app's shipped contract (commit e418f4f); the head is bound by the challenge store and the device-signed body instead.

## Evidence pointers

- `tests/unit/github-owner-approval.test.ts` (27), `tests/unit/github-approval-needs-rows.test.ts` (8), `tests/integration/github-approval-routes.test.ts`, `tests/e2e/github-approval-alive.test.ts`, owner-only guard lists in `tests/unit/mobile-session-terminal.test.ts` and `tests/integration/team-access-status-table.test.ts`.

## Class-Closure Declaration (display-only mirror)

- `defectClass`: `unbounded-self-action` (the change adds a spawn and bounded retries).
- `closure`: `n/a` — not a self-triggered controller: every spawn is caller-driven (one per owner Face ID tap, serialized by a per-profile lock), the HOLD is retried exactly once, verification reads are capped at 3, and attempts expire after an hour. Nothing fires on its own.
