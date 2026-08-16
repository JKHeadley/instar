# Side-effects review — Tier-3 S-2: Dashboard Proposals routes + sub-section

**Spec**: `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` — §A10, §A13, §A26, §A48, §A57 Tier-3.

**Scope**: A new route file (`src/server/routes/remediation-proposals.ts`), a standalone dashboard page (`dashboard/proposals.html`), wiring into `AgentServer.ts`, and a one-line visibility change on `TrustElevationSource.hasCollaborativeTrust()` so the routes can consult it.

## What changed

1. **New file** `src/server/routes/remediation-proposals.ts` — implements the three S-2 routes:
   - `GET /remediation/proposals` (list with visible-3 + queued-behind).
   - `GET /remediation/proposals/:id` (detail with §A13 redaction at < `collaborative` trust).
   - `POST /remediation/proposals/:id/dismiss` (§A26 — `collaborative` trust required + 10/hour rate-limit per principal).
2. **New file** `dashboard/proposals.html` — standalone dashboard page that fetches the three routes. Renders each proposal inside an "Untrusted LLM-summarized content" frame per §A10 and prefixes titles with `[REVIEW NEEDED]`.
3. **`src/server/AgentServer.ts`** — imports `registerRemediationProposalsRoutes` + `TrustElevationSource`, mounts the routes after the worktree routes and before the error handler. Wiring is guarded by a try/catch so a misconfigured trust source cannot prevent the server from starting (mirrors the burn-detection-system wiring convention).
4. **`src/remediation/TrustElevationSource.ts`** — `hasCollaborativeTrust()` changes from `private` to public. Identical to the change S-1 makes on its branch; intentional duplication so the merge order doesn't matter.

## Over-block analysis

- **Dismiss is collaborative-only.** The spec is unambiguous (§A26). The 10/hour rate-limit could feel restrictive for a user clearing a deploy-day flood, but the spec rationale (signal-suppression authority) holds — a user clearing real outstanding work hits ten in any reasonable session. The rate-limit returns a 429 with `retryAfterMs`, so the dashboard can surface a meaningful wait time.
- **`X-Instar-Request: 1` required.** Returning 400 (not 403) when the header is missing matches the existing convention in `routes.ts:14412` for `POST /shared-state/sessions/:sid/revoke`. The list route arguably could skip the header check (it's read-only), but the spec line under §A13 reads "All four require bearer auth + `X-Instar-Request: 1`" — applying it uniformly avoids drift.

## Under-block analysis

- **No HMAC on the proposal file.** The route reads proposal JSON directly off disk without verifying the `producingAgentSignature` field defined in §A32. The spec's signature-verification surface is the CI pre-merge gate, not the dashboard read path — dashboard rendering is intended to surface every persisted proposal so a tampered one is human-visible. Adding signature verification at the read boundary would be over-block (it would silently drop tampered proposals from the dashboard, exactly what the user needs to see). The CI gate is the authority that refuses merge on signature mismatch.
- **Dismiss writes JSON in place rather than appending to an audit log.** S-1's `NovelFailureReviewer.dismissProposal()` uses the same in-place mutation pattern (`status: outstanding → dismissed`). The forensic record lives in the file itself plus the structured event emitted via `onEvent`. The route does not call `SafeFsExecutor` for the write because `fs.writeFileSync` of a single status mutation isn't a destructive operation per the SafeFsExecutor scope (which is `rm`/`unlink`/`rmdir`). Cleanup paths in the tests use `SafeFsExecutor.safeRmSync` per the spec mandate.
- **Trust source consults `config.autonomyProfile` at server-construction time.** A profile change at runtime requires a server restart for the dismiss gate to see the new value. This matches the existing pattern (the Remediator bootstrap reads the profile at init). The follow-up Tier-2/Tier-3 work that wires the Remediator into `AgentServer`'s lifecycle will swap the per-request profile read in if config-flip dynamism is required.

## Level-of-abstraction fit

The route layer is a thin HTTP gate over file-system reads of S-1's proposal JSON. It does not duplicate S-1's persistence logic, threshold logic, or LLM-call logic — it consumes the persisted artifact. The redaction guard at the route boundary is the right level: it lets a future migration that introduces `reason.full` on disk (currently only S-1 sample-events carry `reason.redacted`) ship without leaking the new field through the response. The route's redaction is field-name-driven and applies regardless of whether the field is present on disk.

The dismiss authority is gated by `TrustElevationSource`, which is the single policy authority for non-runbook signal-suppression actions per §A26. Route handlers do not interpret trust levels themselves — they call `hasCollaborativeTrust()` and branch on the boolean. Identical pattern to S-1's in-process `dismissProposal()`.

## Signal vs authority compliance

- **Signal layer**: the rate-limit timestamp ring, the redaction guard, the `X-Instar-Request` header check. These flag conditions without making policy decisions.
- **Authority layer**: `TrustElevationSource.hasCollaborativeTrust()` — the single gate for the dismiss write path.

No signal layer holds blocking authority; no authority layer is brittle pattern-matching. Compliant.

## Interactions

- **S-1 (NovelFailureReviewer)**: shares the proposal JSON shape and the `proposals-<machineId>/` directory layout. Order of merge is invariant — if S-1 lands first, the routes read S-1's writes immediately. If S-2 lands first, the routes return empty lists (per the §A13 graceful-empty-dir requirement, covered by test 8) until S-1 starts writing.
- **S-1's in-process `dismissProposal()`**: writes the same on-disk field (`status: dismissed`). The route's dismiss path uses the same shape so the two surfaces are interchangeable. The route additionally enforces the 10/hour rate-limit per-principal at the HTTP boundary, which S-1's in-process call does not (it has no principal).
- **`TrustElevationSource`**: the `hasCollaborativeTrust()` visibility change is benign — it exposes a pure read of the configured profile. No mutability is introduced. S-1 makes the identical change.
- **Dashboard `index.html`**: untouched. The proposals page lives at its own URL until the Remediation tab parent lands.
- **`AgentServer.ts` startup ordering**: routes are mounted after `createWorktreeRoutes` and before `errorHandler`. The mount is guarded by try/catch matching the burn-detection convention — a route-registration failure logs a warning and does not throw.

## Rollback cost

Trivial. Revert the four-file diff. The dashboard page is self-contained — removing it leaves no broken links because no other dashboard markup references it yet. The routes are bearer-auth-gated; removing them returns 404s that the dashboard handles gracefully (the `loadProposals()` fetch surfaces the error in the status line). The `TrustElevationSource.hasCollaborativeTrust()` visibility change is forward-compatible — if S-1 also adds the same public method, the reverts merge cleanly. If only S-2 added it, reverting reduces the surface area to S-1's identical change.

The proposal files on disk are untouched by S-2 except for the in-place status flip on dismiss. Reverting S-2 does not affect any persisted proposal beyond leaving the dismiss flag in place — exactly what a forensic audit would want.

## Tests

Twelve integration tests in `tests/integration/remediation-proposals-routes.test.ts`:

1. 401 without bearer auth.
2. Bearer + header returns the list.
3. Redacted view at < collaborative trust strips `reason.full` + `forensic.rawResponse`.
4. Collaborative trust includes both fields verbatim.
5. Dismiss at supervised trust returns 403 with `trust-level-below-collaborative`.
6. Dismiss at collaborative trust mutates on-disk status to `dismissed` and the list excludes it from outstanding.
7. Missing `X-Instar-Request` header returns 400 on all three routes.
8. Missing `proposals-<machineId>/` directory returns 200 with empty arrays.
9. 10/hour rate-limit returns 429 on the eleventh dismiss, with `retryAfterMs` populated.
10. Unknown proposalId returns 404.
11. Invalid proposalId format returns a non-2xx outcome.
12. Visible-3 cap with two-proposal queued overflow.

All twelve pass. Full `tsc --noEmit` is clean.

## Second-pass review

Marked not-required by the spec gate procedure. The change is read-mostly with one gated write path; both surfaces (read and write) use existing primitives (file-system read, the existing `TrustElevationSource`). No new authority is introduced; no new persistence is introduced; rollback is trivial.
