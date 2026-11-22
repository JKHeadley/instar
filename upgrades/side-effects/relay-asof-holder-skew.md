# Side-Effects Review — Exact receiving sessions across machines

**Version / slug:** relay-asof-holder-skew
**Date:** 2026-11-21
**Author:** echo
**Second-pass reviewer:** independent Codex reviewer (same model family); source and artifact follow-up complete.

## Summary of the change

Tier 2. A sender-only live switch adds a signed session-generation observation before creating a cross-machine session message. The receiver binds to that immutable generation through final injection. Durable exclusive delivery ownership prevents automatic retyping after uncertain physical delivery. The switch ships absent/off; the signed endpoint is available independently. Final focused batch:189 unit checks,15 real HTTP integration checks and7 AgentServer lifecycle/wiring checks; shared complete suite still pending. The change expanded from clock arithmetic because independent review proved that arithmetic cannot fence replacements during transit. Source, tests and registries span messaging, machine HTTP routes, production initialization and feature awareness. Candidate size:31 staged files including the generated carrier ledger; final exact size is recorded at commit. Full-suite result remains pending. Initial design review and successive targeted closure checks produced substantive fixes in signatures, downgrade, ownership and TTL; exact evidence is in the convergence report. Normal commit attempt1 was refused by the offline carrier lint: real feedback marker lacked a supported frozen commitment excerpt. Created actual CMT-2183/CMT-2184 carriers for the existing feedback items and generated their ledger through the sanctioned tool. This metadata correction changes no source behavior.

## Decision-point inventory

- Add signed peer-generation proof, canonical active membership and nonce binding.
- Add exact signed generation comparison at receiver and immediate injection boundary.
- Modify pending recovery: exclusive claim, fresh committed state, durable reservation and bounded increasing retry cadence.
- Modify physical-send error classification: false/throw is outcome unknown, never proof of no write.
- Add default-off live sender admission; pass through legacy off-mode delivery and existing resolver exclusions.

## 1. Over-block

An enabled sender cannot address an older peer lacking the endpoint, or a peer whose current holder cannot be proved within the resource budget. It fails explicitly before relaying payload. Root must verify pool support before enabling; off-mode retains the previous protocol. A genuine replacement cannot receive an older message, even if that would be convenient. Busy or temporarily unavailable known roles may wait within the existing derived five-minute window. No new false-positive content filter exists.

## 2. Under-block

The fence covers Instar's recorded logical session generations. External tmux replacement that leaves false session records is outside its proof. Once-only behavior is per immutable envelope; a client repeating a lost POST response creates a distinct envelope. Stable client submission identity is tracked as fb-cf81617c-e91, owned by messaging reliability / takeover-ready pool. General terminal-notice durability is tracked as fb-292ec9c9-9d3 under messaging reliability / takeover-ready pool, with crash-before-notice-persist acceptance. Existing signed return notices can themselves be lost; this repair does not promise a durable end-to-end notice acknowledgement. Audit retention is bounded and is not an all-time census.

## 3. Level-of-abstraction fit

Generation discovery reuses machine auth and relay signatures, rather than publishing unsigned session lists or introducing keys. Router resolves intent; MessageDelivery checks identity at actual injection; retry owns durable scheduling. The exact physical uncertainty belongs at the synchronous tmux boundary. No new session lifecycle authority is introduced.

## 4. Signal vs authority compliance

Reference: [signal versus authority](../../docs/signal-vs-authority.md). This change enforces enumerable identity and irreversible-action safety invariants, not a heuristic assessment of message worth. Missing signature or generation cannot grant typing authority. Existing session ownership and resolver exclusions remain authoritative. Observations, audits and feature evidence confer no leadership, trust, kill or restart authority.

## 4b. Judgment-point check

Exact signature/id equality and refusing automatic repetition of an uncertain irreversible action are safety floors. Five seconds, bounded proof bytes and finite retry backoff are explicit resource budgets; they do not diagnose death or grant trust. The repair owner judges rollout from actual evidence; counters cannot enable the switch. The spec inventories those choices and their legitimate rejection boundaries.

## 5. Interactions

An exclusive in-memory claim spans state reread, pin persistence, injection and final persistence. Boot recovery and retry cannot compete with a live attempt or act on stale inbox snapshots. A failed final write leaves durable typing evidence and cannot register a successful watchdog. Known holder waits remain received, not queued, so older binaries cannot inject them by name. Bound ids override mutable delivery metadata; absent resolver/checker refuses. Receiver-local expiry derives from accepted signed age and is rechecked immediately before physical injection. Initial callbacks cannot consume retry-owned waits or queued pins; the timer cannot steal fresh local sent work. Canonical revokedAt membership closes the shared middleware's merged-registry gap for this endpoint. Feature evidence includes recovered uncertainty and pinned retry success, distinguishes absent pins from observed replacements and the capability status reads the same live getter as actual sender admission. Confirmed pinned injection is never regressed by later watchdog liveness.

## 6. External surfaces

POST /api/messages/session-generation is machine-authenticated, nonce-bound and signed in response. The strict payload route `/api/messages/relay-machine-generation-v1` uses a domain-tagged authenticated wrapper; old endpoints cannot accept it even if the path is rewritten. Unwrapping occurs only after request authentication; redirects are manual. Required id and flag are validated. The signed digest binds target, exact generation and observation time. All canonical registered HTTP/HTTPS addresses may be tried, without redirects or bearer credentials. Signed envelope recipient fields survive transport/store serialization. The default-off live setting, capability entry, feature ladder and automatically refreshed awareness entry describe staged rollout. Missing configuration means off; no installed default migration is required.

## 7. Multi-machine posture

Proofs and delivery notices traverse existing authenticated machine transport. Sessions, delivery claims, receiving retry state and refusal audits are machine-local by design: physical-credential-locality. No user-facing URL is generated. Existing standing-down/topic-transfer exclusions remain. Sender notices follow the existing sender-notifier path, avoiding a second user alerts channel. Topic transfer does not authorize late-binding a replacement.

## 8. Rollback cost

Live rollback: disable multiMachine.messageSessionGeneration.enabled for new sends, without restart. Receiver verification of already-bound work remains. Code rollback: waiting/uncertain records use received state, which old recovery refuses to retype; old TTL eventually reports terminal failure. Real old-code rollback experiment at commit 901d368e7 against current MessageStore: zero injections into a reused name, one terminal notice, dead-letter true. No state migration or deletion required. Audit files are inert.

## Verification

Targeted unit tests, fifteen authenticated HTTP integration checks, and seven production AgentServer lifecycle/wiring checks pass on private Node24. The actual AgentServer mount returns a verified signed generation and strict payload ACK, invokes one real pinned delivery, and refuses a canonically revoked peer. Physical tmux alone is substituted. Full shared test:all remains pending its reserved slot. No deployment, push or release claim is made.

## Second-pass review

The reviewer previously stated “Concur with the side-effects review,” then identified TTL ordering during follow-up; that issue was fixed. Final follow-up (including the last deadline/current-id corrections): “Concur with the current source. The TTL ordering, receiver-local expiry, delayed-callback fences, strict wrapper validation and immediate pre-injection checks resolve the targeted findings.” The requested explicit strict route name was added. Final reviewer: “Concur with the current source and side-effects review. The final injection boundary now enforces the shared retry deadline and distinguishes an absent generation from an observed replacement.” No further source blocker was found; reviewer did not run tests. The existing independent source review concurs with the signed binding, exclusive ownership, fresh reread, immediate missing-proof refusal and unknown-outcome recovery.

## Root integration/deployment concurrence

Root reviewed final source, real conformance output, rollback and AgentServer lifecycle proof and approved normal Tier2 commit and reserved complete-suite verification. All seven possible conformance flags are explicitly dispositioned in the convergence report. Maturation harm/hold states remain real gates: deliberate uncertainty drills use isolated test-agent logs, not development production logs. Root concurrence covers source, side effects and the deployment plan, not deployed behavior. Full suite and physical live rollout remain outstanding.

Carrier records CMT-2183 and CMT-2184 preserve the actual root-assigned pool ownership and next-step acceptance text for fb-cf81617c-e91 and fb-292ec9c9-9d3. They do not claim another agent acknowledged ownership or that the work is complete. Foundation implementation remains outstanding under the program pause.

Normal attempt2 passed all55 lints. The instar-dev orphan-deferral check then rejected runtime words “deferred/deferrals” describing busy-session waits. Rephrased them as runtime safety refusal/waits, without hiding postponed implementation or changing source; the two actual foundation obligations retain generated carriers. Attempt3 uses normal gates and a fresh trace.

Attempt3 passed55 lints but rejected the optional causalAutopsy.relatedPrs empty array. Removed the optional field instead of inventing an originating PR. Four commit attempts reflect carrier, wording and trace-schema metadata corrections; source behavior and reviewed tests did not change between attempts.

## Framework generality

The change routes through the shared MessageDelivery/TmuxOperations and SessionManager record abstractions. Generation identity is the common session id and tmux name, not a CLI executable, transcript format or model family. Production current-id checks use SessionManager.listRunningSessions. Existing foreground-process admission comes from ALLOWED_INJECTION_PROCESSES, which combines shell processes with allFrameworkInjectionProcessNames() from the framework registry; the patch adds no Claude-only process literal. Ed25519 proofs, receiver-local TTL, retry ownership and physical uncertainty apply equally to claude-code, codex-cli, gemini-cli and future registered frameworks using this tmux delivery contract. No new launch command or framework-specific prompt is introduced. The runtime fixtures exercise the common abstraction with bash at the physical boundary; physical Claude/Gemini live behavior is not claimed.

Attempt4 passed55 lints, then the framework-generality artifact gate requested this explicit analysis. Attempt5 uses the same reviewed source, expanded artifact and normal gates. The sequential gate corrections explain the five commit attempts; none bypasses a denial.

Framework artifact-only reviewer: “Concur with the framework-generality section. It accurately identifies the shared abstractions and registry-based process admission, and clearly excludes unverified physical Claude/Gemini behavior.” Required blocked decision-audit records ride the retry commit per the normal hook; superseded traces remain local and only the fresh final concurring trace is committed.

## Exact-candidate Full-suite Follow-up

The full318922be1 unit run found3 failures (73679 passed,24 skipped), stopping before integration/E2E. The immutable evidence is /tmp/n73-test-all.log; follow-up diagnosis and exact hashes are in docs/specs/reports/relay-asof-holder-skew-failure-followup.md. This supersedes the earlier pending-full-suite snapshot without claiming a green full suite.

The corrective source delta adds only a catch around MessageDelivery's known read-only isSessionAlive/checkInjectionSafety calls before physical injection. Those failures become explicit retryable results, so legitimate preflight errors are not overblocked as uncertain writes. Generic delivery exceptions and physical false/throw still remain terminal unknown; the new side-effect regression proves that distinction. No generation, signature, expiry, pin, ownership or rollout authority is relaxed. The audit-loss catch now documents its already observable coalesced warning, tested with real filesystem failure and recovery; the ratchet stays494. The remediation fixture is corrected to the actual typed DeliveryResult rather than relaxing the durable verify-failed expectation.

This is within the existing Tier2 spec and shared framework-neutral delivery abstraction; it adds no endpoint/config/installed-file change, migration or new authority. Rollback is the corrective commit only, restoring conservative overblocking but preserving generation safety. Root-requested validation is green: all3 originally failed files together plus2 delivery files (99),15 HTTP integration,7 lifecycle/wiring, and normal Node24 build. Original full evidence remains unchanged. Root concurrence and normal gates are required before commit; another full run remains slot-controlled.

Corrective independent reviewer (existing thread, read-only): “Concur with the corrective source and artifact. The new catch covers only read-only preflight operations; physical and unclassified delivery failures remain terminal unknown.” The reviewer found the tests strengthen no-typing/durable-queue assertions; it did not run tests, and full-suite success remains unclaimed. Root subsequently concurred with the corrective source and artifact before normal commit.

Root focused concurrence: read the actual read-only preflight path and full delta, the side-effect/no-retype regression, real audit warning/reset proof, unchanged baseline494 and typed two-queued-envelope fixture. Root reviewed the combined99 checks and15 HTTP/7 lifecycle/build reports and authorized normal trace/commit. This is corrective source/plan concurrence, not full-suite or deployed-behavior verification; same-family assurance limits remain.
