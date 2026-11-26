# Side-Effects Review — feature switches apply their setting

**Version / slug:** `feature-transition-applies-action`
**Date:** `2026-10-25`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Every feature definition carried an `enableAction`/`disableAction` nothing ever sent, so switching a feature "On" in the dashboard recorded the choice in `discovery.db` while `.instar/config.json` was unchanged and the next boot silently reset the switch. `POST /features/:id/transition` now applies the action server-side (`src/core/FeatureActionApplier.ts`: a loopback request to the server's own route, pinned to the four exact method/path pairs the definitions use, run one switch per feature at a time), records the result on the feature (`feature_state.last_apply_json`, `src/core/FeatureRegistry.ts`), and every feature read carries an honest `effective` state (recorded vs configured vs at-boot, with a plain sentence that never claims "running"). A verified dashboard operator (`X-Instar-Operator-Session`, the existing PIN-unlock proof) may set any feature on/off from any state, with the switch itself written as the consent record (`FeatureRegistry.operatorSet`). Four definitions were corrected to the keys their consumers read (`threadline.relayEnabled`, `evolution.approvalMode`, six default-on features, the tunnel body), and `createFileRoutes` (`src/server/fileRoutes.ts`) no longer returns an empty router when the viewer is off at boot. The legacy Features tab (`dashboard/index.html`) shows the disclosure before enabling a data-sharing feature, sends the proof, and shows the apply result. Files: `src/core/FeatureActionApplier.ts` (new), `src/core/FeatureRegistry.ts`, `src/core/FeatureDefinitions.ts`, `src/server/routes.ts`, `src/server/fileRoutes.ts`, `src/core/PostUpdateMigrator.ts`, `src/scaffold/templates.ts`, `dashboard/index.html`, tests in all three tiers.

## Decision-point inventory

- `POST /features/:id/transition` operator path — **add** — a valid operator proof bypasses the discovery graph and the consent/challenge requirement (the proof IS the consent). Without the proof the existing gate is pass-through, unchanged.
- `FeatureActionApplier` allowlist — **add** — refuses to send anything but the four static pairs; never a block on a user, only on a malformed definition.
- `createFileRoutes` off-at-boot early return — **remove** — the existing per-request `config.enabled` guard now covers both the live-disable and off-at-boot cases.
- `resolveConfigValue` — **modify** — reads `defaultOn` / `configEnabledValue` so bootstrap and the shown state agree with the consumers.
- `PATCH /config`, `PATCH /api/files/config`, `POST /telemetry/*` — **pass-through** — the applier is a client; their validation is untouched and is what decides.

---

## 1. Over-block

- A feature whose definition names a request outside the four allowlisted pairs is never applied (`not-applied`). Today every built-in is on the list (unit-pinned); a future definition naming a new route must extend the list, which is the intended friction.
- A non-`default` `userId` never has its switch applied. In a multi-user install a secondary user's switch records only. That is deliberate (settings are agent-wide); the honest state shows `recorded-only` with the reason.
- The dashboard asks for the PIN once when the in-memory proof is absent (after a reload, or past the 15-minute proof). It never asks while a proof exists. The operator's rule against stacking a PIN on what the Bearer already does is otherwise honoured.

## 2. Under-block

- `userId` is a caller-chosen body field, not an identity; the `default`-only rule stops accidents, not a Bearer holder (who could `PATCH /config` directly anyway).
- "On" still never proves the subsystem initialized (response review configured on but no intelligence provider; the always-on evolution system ignoring its key). The wording says "running is not separately verified" and the evolution note says the key is ignored — honest, not verified.
- A section set to `null` or absent follows `defaultOn`; an object without a boolean `enabled` follows `defaultOn` too — both now agree with every consumer checked (`FeedbackManager`/`DispatchManager` read `this.config.enabled`; publishing/tunnel/backup/… read `enabled !== false`). No known under-block remains in the resolution; a future consumer with a different default must set `defaultOn` or a `configuredResolver`.

## 3. Level-of-abstraction fit

Right layer. The applier is a thin client; the authority over what may change stays in the routes that already own it (`PATCHABLE_CONFIG_KEYS`, the executable-selection fence, CSRF, telemetry provisioning). The honest-state derivation lives in the registry beside `bootstrap()` so the two can never read config differently. No parallel gate was introduced.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface with brittle logic.

The applier decides nothing: it forwards a static request and reports the route's verdict. The operator path removes a block for a verified principal using the existing operator proof. The allowlist is an invariant over static code, not a judgment.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The effective-status table is a deterministic mapping of three recorded facts; its honesty comes from saying less, not from guessing.

## 5. Interactions

- **Shadowing:** the operator path runs instead of `transition()` only when a proof is present AND verifies. An OMITTED header runs the unchanged agent path; a PRESENT-but-invalid header (forged, expired, or empty) answers 401 `OPERATOR_PROOF_INVALID` and is never downgraded to the agent path (integration-tested both ways).
- **Double-fire:** the dashboard sends one request; the server applies once. A re-sent identical switch re-applies the same idempotent config patch.
- **Races:** two switches on one feature are serialized by a per-feature promise chain, so an earlier disable cannot land after a later enable (integration-tested with overlapping requests). The loopback request runs inside the serialized section.
- **Feedback loops:** `bootstrap()` reads config at boot and may reset a switch whose apply was refused; the retained `lastApply` makes that visible instead of silent. No loop: bootstrap never applies.
- `fileRoutes` change: the existing `router.use('/api/files', …)` guard already 404s every file route except `/config` while disabled; removing the early return only makes that guard the single source of truth.

## 6. External surfaces

- `POST /features/:id/transition` response gains `apply`, `effective`, `viaOperatorSwitch`; `GET /features*` gain `effective`. Additive; existing fields unchanged.
- `feature_state` gains one nullable column; older code ignores it.
- `.instar/config.json` is now actually written by a feature switch (the whole point). The write goes through `PATCH /config`'s existing allowlist.
- **One-time visible state change on every deployed agent:** on the first boot after this update, `bootstrap()` reads the seven default-on features (publishing, tunnel, git backup, file viewer, input guard, external operations, evolution system) as ON wherever their key is absent — which is what the runtime was already doing — and moves their rows from `undiscovered` to `enabled` (no discovery event is logged for this, as for any bootstrap sync). The Features tab therefore shows them On, the boot log's "N enabled" count rises, and the DiscoveryEvaluator stops surfacing them as undiscovered. Correct, and named in the release note.
- `GET`/`PATCH /api/files/config` are now reachable while the viewer is off at boot (same handlers, CSRF header and validation as while on).
- The console page on `feat/console-native-1` will read `effective`; that branch is told the field name (topic 127504) and `dashboard/console/` is untouched here.
- **Operator surface:** the switch is on the dashboard Features tab (phone-reachable); the only operator action added is a PIN prompt when the proof is absent, in the same tab. No API-only operator action.

## 6b. Operator-surface quality

`dashboard/index.html` Features tab:
1. **Leads with the primary action?** Yes — the on/off switch stays on each card as before; the disclosure dialog appears only on enabling a data-sharing feature, and confirms in one tap.
2. **Zero raw internals as primary content?** Yes — the card sub-line shows `effective.summary` (a plain sentence) and only when the state is not a plain on/off; `apply.outcome` surfaces as a toast sentence with the route's reason, never JSON.
3. **Destructive actions de-emphasized?** Not applicable — the switch is symmetric; disabling shows no extra prompt.
4. **Plain language + phone width?** Yes — the dialogs are native `confirm`/`prompt` (phone-safe), the sub-line reuses the existing `feat-card-desc` style, and no new table or wide element was added.

---

## 7. Multi-machine posture

**Machine-local by design.** Config, `discovery.db` and the boot snapshot are per machine, like every `PATCH /config` today. The switch changes THIS machine's setting; `effective` describes THIS machine. No user-facing notice is emitted (no one-voice gating needed); the durable state (`last_apply_json`) is per-machine audit that does not strand on topic transfer (it is not topic-scoped); no URLs are generated. Fanning a switch out across machines is a separate question and is not implied by any wording here.

## 8. Rollback cost

- **Hot-fix release:** revert the PR. Pure code plus one nullable column.
- **Data migration:** none; the column is ignored by older code.
- **Agent state repair:** none. The CLAUDE.md section is appended by migration and is harmless if the code is reverted.
- **User visibility:** a reverted install returns to "switch records only"; config keys already written stay as the operator set them.

---

## Conclusion

The review, three outside review rounds and an independent second pass reshaped the design in four ways: the loopback client was pinned to an explicit allowlist; the separate retry route and a duplicate timestamp column were cut; the shown state stopped claiming "running" and stopped inventing a boot snapshot; and the definitions were aligned with their real consumers (two dead keys, six default-on features). Round 3 added display-only corrections (Threadline's environment override named on the card, every restart-dependent undo note qualified, the detail panel re-rendering after a toggle, the read-only switch disabled in the detail view). Found-but-out-of-scope: the `feedback`/`dispatches` object-without-`enabled` mismatch is now handled consistently by `defaultOn` (both default-off), so nothing remains queued from it. Clear to ship once the three test tiers are green.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude, read-only, 2026-10-25)
**Independent read of the artifact: concur** (after one concern round)

First pass: "concern" — all eight code checks (allowlist + no redirects; present-but-invalid proof → 401; serialization wraps write + apply; telemetry local-before-remote with the pending-deletion shape intact; one-level-deep disk-wins merge; object-without-`enabled` → defaultOn; dashboard always renders the sentence and re-unlocks once on 401; no other consumer of the renamed keys / the removed early return) PASSED, and seven findings were raised: four places where this artifact's prose lagged the code (the "forged proof = no proof" bullet; a stale feedback/dispatches under-block; the missed one-time first-boot flip of the seven default-on features' rows; "two rounds"), and three low edge cases in code (an EMPTY proof header counted as omitted; a `null` config section ignored `defaultOn`; an install without the PIN endpoint lost the Features tab). All seven were fixed; the reviewer re-read each at its new location and answered **concur, no findings**.

---

## Evidence pointers

- Spec: `docs/specs/feature-transition-applies-action.md` (Review changes section lists each round-1 finding and its resolution); reports under `docs/specs/reports/feature-transition-applies-action-*.md`.
- Unit: `tests/unit/feature-action-applier.test.ts`, `tests/unit/feature-registry-apply-and-operator.test.ts`, `tests/unit/PostUpdateMigrator-featureSwitch.test.ts`.
- Integration: `tests/integration/feature-transition-applies-action.test.ts`.
- E2E: `tests/e2e/feature-switch-applies-config.test.ts`; `tests/e2e/feature-registry-lifecycle.test.ts` updated to the real consumer semantics.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable to the fix itself (the defect is in server code: an action defined but never invoked, and definitions bound to keys nothing read).

Self-action class, explicit negative declaration (mirrors the trace's `classClosure`): `defectClass: unbounded-self-action`, `closure: n/a`, reason: "one-shot user-driven action, not a self-triggered loop: the setting change runs once inside an operator- or agent-initiated POST /features/:id/transition and is serialized per feature; no tick, retry, respawn or recovery path triggers it".
