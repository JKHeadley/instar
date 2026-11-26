# Side-Effects Review — Native session screen (device-key session output and input)

**Version / slug:** `mobile-native-session-screen`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see the end of this file)`

## Summary of the change

Operator request (Justin, Telegram topic 134088, 2026-11-03 22:01 and 22:55 PST): the chat's session button opens a native session screen in the app. Spec: `docs/specs/mobile-native-session-screen.md` (converged, approved).

- `src/server/mobilePairingRoutes.ts`: two `DEVICE_ALLOWLIST` entries (`GET /sessions/<name>/output`, `POST /sessions/<name>/input`), active devices, `ownerOnly: true`, own buckets `session-output` (90/min) and `session-input` (12/min). New rule flags `ownerOnly` (403 `owner-phone-required` for a non-owner person) and `bucket` (named bucket). `deviceBucketOk` keys by device and bucket name (the media rule keeps its old key) and drops emptied windows once the map holds more than 64 keys.
- `src/server/mobileSessionTerminalRoutes.ts` (new): a device-only router. Non-device requests call `next()` untouched. For an owner device: exact session resolution on this machine, `sid`/`machine` binding, async pane capture, credential redaction, plain-text filter, durable replay record, machine-wide input window, audit log, and a bounded pool lookup to name the machine of a session that is not here.
- `src/server/AgentServer.ts`: mounts the router before the main routes when mobile pairing exists; wires state, capture, send, peer lookup, nicknames, secrets.
- `src/core/PostUpdateMigrator.ts` + template: one CLAUDE.md bullet (sniff "native session screen") after the "Open session" bullet. `src/server/CapabilityIndex.ts`: one sentence.
- Tests: unit, integration, e2e.

Tier 2 (security-sensitive: new device access to session routes). Size: 1 new module (~290 lines), ~45 lines wiring/allowlist, ~25 lines migration/index, 3 test files (~520 lines). Effort: 6 spec rounds (the Tier-2 cap; later rounds each found real security gaps), 1 commit attempt so far.

## Decision-point inventory

- Device allowlist membership for the two routes — add — exact method/path/status rules.
- `ownerOnly` — add — refuses non-owner persons in the authenticator; the router re-checks.
- Named buckets, machine-wide input window — add — fixed counts, 429.
- Plain-text filter, exact resolution, `sid`/`machine` binding, replay record — add — each can only refuse.
- Credential redaction — add — changes only what a device sees.
- "Where is this session" lookup — add — a signal shown to the operator; never grants access.

## 1. Over-block

A phone whose clock is far off is already refused by the existing ±60 s window. A session record that is `starting` is reachable; a tmux session Instar does not track is not (the dashboard can reach it; the phone cannot, deliberately). Typing more than 12 messages a minute across all phones gets 429. Text with control characters (pasted escape codes) is refused rather than cleaned server-side; the app strips them before sending. A session whose name was reused after the phone opened it answers 409 and must be reopened.

## 2. Under-block

Redaction is exact-match: a token split by a wrap or encoded differently can reach the owner's phone. Accepted: the owner's PIN unlock already returns the API token itself to the same phone. With multi-route off, a replay to another machine that holds the same device record and has taken over the paired host within 60 s is not caught by the per-machine replay record (accepted; requires a captured TLS request signed by the owner's Secure Enclave key, and the effect is the owner's own text typed once more). Other secrets a session prints are shown, as on the PIN dashboard.

## 3. Level-of-abstraction fit

Access control stays in the existing device authenticator (one new generic flag). Route behaviour sits in a dedicated router in front of the Bearer handlers, so the Bearer path is not touched. Pane capture and injection go through the existing SessionManager surfaces (`captureOutputAsync`, `sendInput`). The machine lookup reuses `poolPeerFetch` and `resolvePeerUrls`, as `GET /sessions?scope=pool` does.

## 4. Signal vs authority compliance

Every refusal is a deterministic boundary check (identity, role, exact id/name match, character class, exact digest, fixed counts), the structural-validation class `docs/signal-vs-authority.md` exempts. No heuristic gains blocking power. The machine lookup only words an answer; it never allows or refuses access.

## 4b. Judgment-point check

No competing-signals decision point is added; all points are classified `invariant` in the spec with reasons.

## 5. Interactions

- Mounted before `this.app.use(routes)`, after `authMiddleware`; Bearer requests fall through to the same handlers (integration and e2e tests prove it).
- `deviceBucketOk` keeps the media rule's exact key (`deviceId`), so media chunk limits are unchanged.
- `sendInput` for Codex sessions with Stage B on journals and may queue; `ok` is reported as "accepted", and the app says "Sent. It appears in the output when the session takes it."
- The other mobile builder's console ticket may add allowlist rows nearby; rows are independent entries.
- The coverage test that counts `conversationRef` rules is unaffected (the new rules are not conversation routes); the new unit test pins the two `ownerOnly` rules.

## 6. External surfaces

The iPhone app gains two device routes; answers are new and additive. Bearer callers see no change. Peers receive at most one `GET /sessions` per missing name per 3 s (15 s once found) and at most 8 names per phone per minute. New files: `logs/mobile-session-input.jsonl` (rotated at 2 MB), `state/mobile-session-input-replay.json` (3-minute entries).

## 6b. Operator-surface quality

No dashboard or approval-page file is touched. The operator surface is the iPhone app (separate repo, commit e112dac): plain-language errors, no raw codes, the session text first, the dashboard link only for an old server.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design (`hardware-bound-resource`): a session's pane exists on one host. A request bound to another machine, or a session found on another machine, gets a plain reason naming it from this machine's registry; nothing is proxied. The audit log and replay record are machine-local for the same reason. The sessions list uses the existing pool read. No notices, no generated URLs.

## 8. Rollback cost

Revert the PR. Phones then get 403 `device-not-allowed` and the app offers the dashboard. The audit log and replay file stay behind, harmless. The CLAUDE.md bullet stays true on an older server (it names the 403 fallback). No config or data migration.

## Conclusion

The change gives the owner's phone the session reading and typing the PIN dashboard already offers, with tighter limits than the dashboard (plain text only, rate windows, replay record, audit). Remaining exposure is within what the PIN unlock grants. Clear to ship after the second-pass review.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (Claude Opus 5.5), read-only, given the artifact and the diff.
**Independent read of the artifact: concur**

No way was found for a non-owner, revoked, unsigned or credential-less request to read or type: device requests must match an allowlist row, pass the signature and ledger-revocation check, and are refused as non-owners in the authenticator and again in the router. Non-device requests fall through `next()` to the unchanged Bearer handlers. Typed text is filtered for control characters, and the durable replay record (keyed on the canonical signed string) is written before typing and fails closed. All refusals are structural. One loose claim (emptied bucket windows are dropped only past 64 keys) was corrected above.

## Evidence pointers

- Spec and report: `docs/specs/mobile-native-session-screen.md`, `docs/specs/reports/mobile-native-session-screen-convergence.md`.
- Tests: `tests/unit/mobile-session-terminal.test.ts`, `tests/integration/mobile-session-terminal.test.ts`, `tests/e2e/mobile-session-terminal-alive.test.ts`.
- Feedback filed: fb-8e2a2b9c-99c (Bearer input raw name), fb-7b984fff-335 (async injection).
