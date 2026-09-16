# Side-Effects Review — Operator-gated subscription re-login configuration

**Version / slug:** `relogin-operator-config`
**Date:** `2026-09-16`
**Author:** `Echo`
**Second-pass reviewer:** `not required — this changes server configuration lifecycle, not tmux/session lifecycle`

## Summary of the change

This change adds `POST /subscription-relogin/configure`, a narrow dashboard-PIN-session-gated control surface for changing the existing assisted re-login block on the machine serving the request. It validates the complete authority-bearing input, preserves unrelated subscription-pool configuration, writes atomically, appends a names-only audit row, and writes the existing supervisor's planned-restart signal so the boot-constructed runtime actually adopts the new policy. It also adds capability/template/migration awareness and unit, integration, and AgentServer lifecycle tests.

## Decision-point inventory

- `validateSubscriptionReloginOperatorInput` — add — hard-invariant API validation for booleans, the closed mode enum, exact email identities, and bounded integer evidence floors.
- `POST /subscription-relogin/configure` — add — accepts configuration authority only from a recent dashboard operator session.
- `applySubscriptionReloginOperatorConfig` — add — idempotently persists the already-authorized policy and requests a planned supervised server restart.

---

## 1. Over-block

The endpoint rejects non-email account identifiers and evidence floors outside 0–10,000 repairs or 0–3,650 days. This is intentional: the unattended policy is specified as exact email identities, and larger floors have no practical rollout meaning. Approval mode is also required to carry a structurally valid policy block, even though it does not consume the allowlist until switched to unattended; callers should send the existing defaults.

---

## 2. Under-block

The route does not prove that every admitted identity already has a usable browser profile. Profile readiness remains owned by the Playwright profile registry and the re-login service's point-of-use checks; a missing, ambiguous, or unverified profile refuses the repair rather than broadening authority. A holder of both the API bearer token and a recent operator-session token can configure the feature, which is the intended dashboard authority boundary.

---

## 3. Level-of-abstraction fit

This belongs at the subscription re-login control surface, not the generic bearer-writable `/config` route. The route reuses the dashboard's existing operator proof, the existing config schema, `SafeFsExecutor` atomic writes, and the existing supervisor restart-request file. It does not duplicate browser, policy, or process-supervision logic.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] Hard-invariant exception — the blocking checks validate a closed, enumerable API schema and an existing operator-session authority.

The validator does not interpret conversation or infer intent. It checks types, a two-value mode enum, exact email syntax, bounded integers, and the invariant that live unattended mode cannot have an empty allowlist. These are the hard-invariant validations explicitly permitted by `docs/signal-vs-authority.md`. The authority decision happened when the operator unlocked the dashboard and submitted the policy.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals decision point. The route accepts an explicit operator choice within closed mechanical bounds. Runtime repair judgment, security challenges, identity proof, and evidence policy remain in the existing re-login service.

---

## 5. Interactions

- **Shadowing:** The narrow route avoids the generic `/config` allowlist, so it cannot silently expose the rest of `subscriptionPool` to bearer-only writes.
- **Double-fire:** Identical replays are detected before persistence and return `changed:false, restartRequested:false`; they do not create restart storms.
- **Races:** Config replacement and restart-signal replacement use atomic sibling writes. A concurrent legitimate config writer could still win last-writer-wins at the whole-file level, matching the existing file-backed configuration model.
- **Feedback loops:** The supervisor consumes the planned restart signal once. The new process reads the persisted policy; the endpoint does not call itself or enqueue a retry.

---

## 6. External surfaces

The new external surface is a bearer-authenticated route that additionally requires a recent dashboard PIN unlock. It returns only mode, exact admitted identities, changed state, and whether a restart was requested; it returns no secret values. Persistent effects are the config block, a names-only JSONL audit row, and the standard planned-restart signal. The operator action is phone-completable: the dashboard PIN exchange already mints the required short-lived session, and the Subscriptions workflow can call this route without machine access.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer or form is changed in this patch. The route completes the already-present phone workflow's missing backend authority path; it exposes no raw internals as primary content, no destructive action, and no layout surface. Existing Subscriptions UI quality is unchanged.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Subscription credentials, browser profiles, CLI config homes, and re-login runtimes are machine-local security authorities, so each machine must receive and audit its own exact policy. The caller reaches each machine through its authenticated mesh/Tailscale URL after one PIN unlock on that machine. Pool-wide status remains proxied on read through `GET /subscription-relogin?scope=pool`. The route emits no user-facing notice, does not bind state to a conversation/topic, and generates no URL. The planned restart preserves tmux sessions and is handled by that machine's existing supervisor.

---

## 8. Rollback cost

- **Hot-fix release:** revert the route/helper/awareness changes and ship the next patch.
- **Data migration:** none. The persisted `assistedRelogin` block is already part of the supported config schema.
- **Agent state repair:** none. A leftover audit row is inert; a consumed restart signal is already removed by the supervisor.
- **User visibility:** rollback removes remote configuration but leaves the configured runtime policy working. The file can still be changed locally if an emergency rollback occurs.

---

## Conclusion

The review found and closed the primary side-effect risk: a repeated request could otherwise cause repeated server restarts. The helper is now idempotent and only writes/restarts when the effective authority block changes. The route stays outside the generic bearer config surface, requires the existing operator proof, keeps runtime status honest until the supervised restart, and is clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

This uses the existing planned server-restart mechanism and does not spawn, kill, resume, or alter user sessions; it does not enter the high-risk tmux/session-lifecycle class requiring a dedicated second-pass reviewer.

---

## Evidence pointers

- `tests/unit/subscription-relogin-operator-config.test.ts`
- `tests/integration/subscription-relogin-routes.test.ts`
- `tests/e2e/subscription-relogin-lifecycle.test.ts`
- Focused result: 4 files, 23 tests passed; TypeScript and lint passed.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller change — not applicable.
