# Side-Effects Review — Native Schedule, Promises and Machines reads for the iPhone app

**Version / slug:** `mobile-native-ops-screens`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Adds `src/server/mobileOpsRoutes.ts`: three read-only routes, `GET /mobile/jobs`, `GET /mobile/commitments` and `GET /mobile/machines`, mounted inside `createRoutes` (`src/server/routes.ts`), each returning a trimmed summary built from the same server-side reads the console's Schedule, Promises and Machines pages use (`jobsPoolMerge(buildLocalJobs())`, the commitments mesh merge, the `/pool` view). The `/pool` handler body and the `/commitments?scope=mesh` merge are extracted into `poolView()` and `commitmentsMeshRows()` with no behaviour change. Three GET entries are added to `DEVICE_ALLOWLIST` (`src/server/mobilePairingRoutes.ts`; active devices, no body). Inside each route an owner-or-bearer check admits only the bearer token (checked explicitly with `bearerMatches`) or a device whose person resolves to `owner`. Agent awareness: one bullet in the Mobile app routes CLAUDE.md block (template + `migrateClaudeMd` insertion, `src/core/PostUpdateMigrator.ts`) and the endpoints in `CapabilityIndex`. Spec: `docs/specs/mobile-native-ops-screens.md` (converged in 6 rounds, codex-cli:gpt-6-astra every round). Tier 2: widens device-key access. Size: about 490 lines of new module, roughly 60 lines changed elsewhere, about 450 lines of tests. Effort: 6 spec rounds (the Tier-2 cap; the external reviewer found one small display-classification edge per round late on), 1 commit attempt so far.

## Decision-point inventory

- `DEVICE_ALLOWLIST` — modify — three exact GET paths added for active devices (authentication by path, existing model).
- `ownerOrBearer` (new, in each route) — add — authorization from the authenticated principal's resolved role; deterministic, fails closed.
- Summary field allow-list — add — a fixed redaction contract; only listed fields leave the server.
- Job status / promise ordering / machine state words — add — display classification only; gates nothing.

---

## 1. Over-block

- An MSP phone the owner trusts cannot see these screens, even with every MSP grant switch on: the grant switches cover Slack and the owner's app conversations, not this operational view. This follows the people-and-roles owner-only default; widening it is a separate decision.
- A job whose slug is not an identifier (`[A-Za-z0-9][A-Za-z0-9._-]{0,79}`) is dropped from the list. Real slugs are kebab-case; no current job is affected.
- No other block surface: the routes are reads.

## 2. Under-block

- An owner phone sees prose the console shows (job descriptions, promise text); the secret scrubber is pattern-based and can miss an unusual secret shape, exactly as the console can show it. Bounded by the console-parity rule and the length caps.
- A stolen-but-unrevoked owner phone can read these views, as it can read chats today; revoke is the remedy (unchanged).

## 3. Level-of-abstraction fit

Right layer. Device authentication stays in `deviceAuthenticator` (path allowlist) and person resolution in people-and-roles; the role check sits in the route, the same place `/mobile/people/:id/grants` checks for an owner phone. The data comes from the existing server reads rather than re-implementing pool merging. The display rules mirror the console's view models (`dashboard/console/*-model.js`), which run in the browser and cannot be imported server-side; the spec pins the shared rules (10-minute late grace, 15-minute replica freshness).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over agent behaviour or information flow beyond authentication/authorization of a read.

The only refusals are authentication (existing device check) and authorization by the authenticated principal's role, which are invariants (Know Your Principal), not brittle detectors judging content. The status words (late, failing, stale, estimated) are display signals that block nothing.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point is added. The role check is an identity invariant; the display rules are copied deterministic rules with explicit "unknown"/"estimated" outcomes when the input is unmeasurable.

## 5. Interactions

- `jobsPoolMerge` cache: phone reads share the console's 3 s cache and its peer fan-out; the shared per-device read allowance bounds how often a phone can ask.
- `/pool` and `/commitments?scope=mesh` now call extracted helpers; their bodies are moved, not changed (existing tests for both routes cover them).
- Parallel work: `echo/mobile-console-device-signin` and `echo/mobile-native-session-screen` also add `DEVICE_ALLOWLIST` entries; a merge conflict there is resolved by keeping every entry. The `DEVICE_ALLOWLIST coverage` test counts `conversationRef` routes; these three are not conversation routes and are not flagged.
- `DegradationReporter`: a failed read adds one `MobileOpsScreens.read` event, which (like any recent degradation) marks `/health` degraded until it ages out. That is the intended visibility.

## 6. External surfaces

- New HTTP routes visible to paired owner phones and the bearer token. Answers carry `schemaVersion: 1` and `Cache-Control: no-store`.
- Agents' CLAUDE.md gains one bullet (template and migration).
- The iPhone app (separate repo) consumes them; an older server answers `403 device-not-allowed`, which the app words as "update the agent to see this here".
- Depends on the clock for "late" (an estimate against this server's clock, documented).

## 6b. Operator-surface quality

No dashboard, approval page or grant form is touched. The operator surface is the native app screen (separate repo): plain words, worst-first ordering, pull to refresh, explicit "too old", "owner only", "couldn't reach <machine>" and "may be out of date" messages, verified with simulator screenshots of seeded data.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Jobs: proxied-on-read through `jobsPoolMerge` (online peers' `/jobs`, short-TTL cache; unanswered peers reported by verified name and count).
- Promises: replicated through the commitments mesh view (own rows plus `CommitmentReplicaStore`); replica rows carry `stale`.
- Machines: replicated through the pool registry heartbeat, as `/pool` reads it.
- Device authentication: machine-local, machine-local-justification: physical-credential-locality (the device key verifies only where its record lives); no new device state.
- No notices, no durable state, no generated URLs.

## 8. Rollback cost

Revert the commit. No data is written, so there is nothing to repair; phones fall back to "update the agent to see this here". The CLAUDE.md bullet would remain on migrated agents and point at routes that no longer exist (harmless; a later migration can remove it).

## Conclusion

Safe to ship: a read-only, owner-only, console-parity surface with explicit fail-closed authorization, field allow-listing and tests on both sides of every access rule.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**

Concur with the review. `ownerOrBearer` fails closed: the bearer token only through the explicit `bearerMatches` check, otherwise only a device principal whose resolved person is the owner; the notification token, MSP phones, removed people and revoked phones are refused and each is covered by an integration test. Only the listed fields leave the server (machine ids only as hashed row keys; names through `verifiedEntityName`; free text scrubbed and capped). The `/pool` body and the `?scope=mesh` merge moved into the helpers unchanged (merge-base diff). Size figures corrected per the reviewer.

## Evidence pointers

- `tests/unit/mobile-native-ops-screens.test.ts` (33 cases), `tests/integration/mobile-native-ops-screens.test.ts` (11 tests), `tests/e2e/mobile-native-ops-screens-alive.test.ts`.
- Convergence report: `docs/specs/reports/mobile-native-ops-screens-convergence.md`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
