# Grok Build Integration Spec — external review pass 2

**Reviewer family:** codex (gpt-5.6-sol), run with no repository access.
**Date:** 2026-08-14
**Spec reviewed:** docs/specs/grok-build-framework-integration.md (draft, post-pass-1 corrections)

> Second of two external families. Findings below independently corroborate pass 1 on:
> billing sink unverified, quota mitigation insufficient, accounting covering only one
> transport, confinement not real, resume semantics assumed, and migrations able to undark.

---

1. **HIGH — §0, §3.1:** The claim that a successful keyless probe “could only have been subscription-billed” is inferred, not verified. Credentials may come from config, keychain, a deployment credential, or server-side account billing rules; a JWT scope proves access, not charging source. **Fix:** obtain vendor confirmation or billing-ledger evidence, and label subscription billing unverified until a controlled run changes an observable subscription balance without changing API usage.

2. **HIGH — §3.1, §9:** Auth precedence was not “confirmed by probe.” Testing with API keys absent does not test precedence, expired-session behavior, or fallback after initialization. The init-only check permits an expired token to fall through to `XAI_API_KEY` or `GROK_DEPLOYMENT_KEY` mid-run. **Fix:** launch every child with all API/deployment credentials removed, use a dedicated credential-only `GROK_HOME`, and test active, expired, malformed, and revoked sessions against valid fallback keys.

3. **HIGH — §6.1, §13.1:** Reporting quota as `unknown` does not mitigate the invisible wall; it only labels it. Empirical burn cannot reveal remaining allowance, reset timing, vendor-side adjustments, or concurrent consumption. **Fix:** automatic routing must fail closed on `unknown`; add explicit manual-use policy, hard local spend/token/concurrency caps, and a shared reactive circuit breaker that opens immediately on quota exhaustion without retries.

4. **HIGH — §3.3, §13.5:** The two-machine design has no shared admission or exhaustion state even though both machines consume one pool. Each may continue routing after the other discovers exhaustion, causing retry storms and duplicate work. An “operator conversation” is not mitigation. **Fix:** maintain atomic, account-scoped shared breaker/cooldown state, host-attributed usage, and per-machine budgets; exclude credentials and host-local session state from replication.

5. **HIGH — §5, §6.1, §12, §14:** Routing semantics are internally unresolved. Tests require routing to select Grok, while §6.1 says unknown must not be treated as available and §14 leaves automatic eligibility open. **Fix:** decide before implementation: either manual/component-pinned use only, or define an explicit `unknown` eligibility policy with budgets and failure behavior. Test that exact policy.

6. **HIGH — §4.1, §8:** An empty read-only working directory does not provide “no repo access.” The process can still read absolute paths, home-directory files and credentials; disabling web search does not block shell-based networking or other tools. **Fix:** enforce an OS-level filesystem/network sandbox, expose only the input, deny all tools by default, use an isolated home, and test attempted reads and network egress.

7. **HIGH — §4.2:** ACP permissions, cancellation, framing, protocol negotiation, and fail-closed behavior are unspecified. A malformed or lost permission response could grant tools, hang indefinitely, or leave actions running after cancellation. **Fix:** specify ACP version negotiation, permission default-deny, request deadlines, message-size limits, cancellation acknowledgement, process-tree termination, and protocol-violation handling.

8. **HIGH — §9, §13.1, §13.3:** The required stall matrix is deferred documentation, not a recovery design. No behavior is defined for token expiry mid-stream, quota errors disguised as generic 429/403, partial output, or a request that committed side effects before stalling. **Fix:** define normalized terminal states and per-state retry rules now; auth/quota failures must not retry automatically, and agentic work must not be replayed unless proven idempotent.

9. **HIGH — §0, §6:** “Exact” and “authoritative” token accounting are inferred from field names. The spec does not establish whether cached/reasoning tokens overlap other fields, whether top-level and `modelUsage` totals double-count, or whether the values represent billing tokens. **Fix:** retain the full versioned raw envelope and model/request identifiers; define non-overlapping accounting semantics only after reconciliation against vendor evidence.

10. **HIGH — §6, §6.1:** Accounting covers headless JSON runs, not ACP or TUI sessions; §0 explicitly leaves `grok trace` unverified. Framework-wide `usageCoverage` can therefore appear healthy while the economically significant agentic path is unmetered. **Fix:** track coverage by transport and reject or explicitly exempt unmetered transports from budgeted routing until live accounting is implemented.

11. **HIGH — §0, §7, §8, §13:** The observed 12,061-token minimum overhead is economically material, yet there are no invocation, concurrency, or component budgets. Enabling third-family review could consume the shared weekly pool on routine reviews regardless of prompt size. **Fix:** require per-component opt-in, invocation caps, concurrency limits, review sampling/batching, and a kill switch independent of general framework registration.

12. **MED — §4.1, §9:** `-p <PROMPT>` places potentially sensitive content in process arguments and risks argument-length failure. It also leaves shell-safe spawning unstated. **Fix:** pass prompts over stdin or a protected temporary file, invoke without a shell, impose size limits, and test prompts beginning with flags and containing arbitrary bytes.

13. **MED — §4.1, §9:** “Single JSON object” is treated as stable despite no handling for stdout diagnostics, schema drift, truncation, missing usage, non-finite values, or exit 0 with partial output. Using the answer while silently dropping metrics would defeat accounting. **Fix:** strict versioned parsing must fail the call loudly when required accounting fields are absent or invalid; preserve stderr separately and cap output sizes.

14. **MED — §3.2, §13.3:** Surfacing server errors verbatim neither ensures correct classification nor safely exposes them. Messages may change, contain secrets, or collapse quota, tier, auth, and transient throttling into the same status. **Fix:** sanitize raw details and map status/code/body into stable internal categories, with an unknown-server-error category that fails closed.

15. **MED — §3.3:** Per-machine re-login assumes simultaneous sessions are supported and that a second login does not revoke or rotate the first. That is not verified. **Fix:** test concurrent sessions, refresh, logout, and revocation across two hosts before authorization; otherwise specify single-active-machine operation.

16. **MED — §4.2:** “Maps directly” from Grok session flags to existing resume semantics is an unsupported assumption. Nothing verifies session identity, working-directory binding, account/model compatibility, protocol version, or whether resume can duplicate the last turn. **Fix:** persist and validate host, account fingerprint, model, cwd/sandbox, protocol version, and last acknowledged turn before resume; fail closed on mismatch.

17. **MED — §2, §2.1:** Absolute-path invocation solves only the PATH collision. The default path is mutable user state, may conflict with `GROK_HOME`, and can be replaced or symlinked after validation. **Fix:** define `GROK_HOME` resolution consistently, reject unsafe ownership/permissions and symlinks, pin supported versions, and revalidate the executable at launch.

18. **MED — §0:** “First-party” and “actively maintained” are inferred from an organization name and a recent push. Neither establishes publisher identity, release provenance, compatibility stability, or update safety. **Fix:** verify official ownership and signed release provenance; pin version/checksum and require compatibility qualification before upgrades.

19. **MED — §7, §10, §11:** “Byte-identically unaffected” is false if migrations modify config and generated `CLAUDE.md` for agents that did not opt in. Removing `enabledFrameworks` also does not separately reverse migrations, queued work, or existing sessions. **Fix:** gate awareness/config additions on opt-in or retract the byte-identical claim; define drain, cancellation, session cleanup, and rollback behavior.

20. **MED — §12:** The tests omit the load-bearing failures: expired/revoked auth mid-run, prohibited-key fallback, two-machine exhaustion propagation, concurrent pool use, retry suppression, ACP permission loss, partial JSON, and session resume mismatch. “Answers 200” is also too weak and may incur real subscription usage. **Fix:** add deterministic fault-injection tests for each boundary plus a separately gated, tightly budgeted live canary that verifies charging and concurrent-session assumptions.
