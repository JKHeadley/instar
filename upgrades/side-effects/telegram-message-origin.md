# Side-Effects Review — Telegram message origin

**Slug:** `telegram-message-origin`
**Author:** Echo
**Date:** 2026-09-06
**Second-pass reviewer:** origin_correctness_review reviewing final detector and dashboard delta; prior bounded review retained below

## Summary of the change

Record agent, machine, harness and model evidence before supported Telegram writes.
Retain immutable origin and receipt history independently of the default-visible
footer. Bot and managed browser boundaries execute sealed durable operations;
recording or custody failure holds the original operation. One separately recorded
fixed outage notice uses current application permission and credential ownership.
The implementation spans `src/messaging/telegram-origin/`, the existing relay
store, session lifecycle, producer integrations, HTTP routes and installed-file
migrations. Validation is in progress; this artifact does not authorize rollout.

## Decision-point inventory

- Origin admission — add: validate current scoped credentials, canonical payload,
  durable evidence and exact operation binding before external execution.
- Transport ownership — pass through: existing lease and credential ownership
  remain authoritative; inert peer evidence never grants execution custody.
- Recovery — modify: retain original operation IDs, bytes and author evidence;
  ambiguous external acceptance cannot create a fresh automatic send.
- Content and permission — pass through: origin evidence grants no exemption from
  existing destination, content, tone, emergency-stop or ownership decisions.
- Outage notice — add: a pre-recorded and preclaimed fixed notice has one attempt,
  current hub permission, current owner and shared bounded pacing.
- Browser enrollment — add: private typed transport, current guard observation,
  account canary are checked on dispatch; concrete receipt evidence is required to
  claim acceptance. Live receipt trials remain separate rollout proof.
- Display — add: defaults and conversation overrides change newly prepared
  presentation only; recording is mandatory regardless of visibility.
- Detector verification — add: isolated known-input probes and fresh source health;
  diagnostic success cannot grant sending, ownership or observed-model authority.
- Release readiness — add: reviewed package-bound evidence produces diagnostic
  completeness; an ordinary build cannot issue its own certificate.

## 1. Over-block

Old installed relays without valid scoped credentials are held until migrated and
the session has current binding. Unknown transport acceptance remains held even
when the user intended a retry: the original request's receipt is unresolved.
Unavailable observed-model evidence is represented as unknown/configured rather
than rejecting a valid send merely for lacking an observed model name. Bounded
payload and queue limits are explicit admission constraints. Default lease renewal
was corrected after an actual startup exposed a 60-second ownership gap; explicit
renewal opt-out still takes precedence and can legitimately hold delivery.

## 2. Under-block

This trusts the Instar runtime and does not contain a hostile same-OS-user process
with direct access to transport credentials. Native hook observations establish
what a harness reports, not cryptographic proof of provider execution. Physical
peer handoff, every installed fleet writer and complete signed release evidence
are not yet established. The current source census is a review input, not proof
that every deployed instance is enrolled. No complete runtime claim is made.

## 3. Level-of-abstraction fit

The final Bot API and private browser boundaries enforce immutable operations.
The existing PendingRelayStore remains the sole execution outbox; evidence spools
and peer copies are inert. SessionManager supplies submitting context; destination
topic pins cannot substitute for the sender. Existing producer calls supply their
own authorship evidence; delivery validators cannot become the message author.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md).

The new blockers enforce the documented hard-invariant and transport-idempotency
exceptions: credential validity, exact payload binding, retained intent and receipt,
current custody and immutable operation identity. They do not classify what prose
means or infer operator intent. Existing conversational authorities remain in place.
Recovery diagnosis is an LLM-supervised signal consumer; it cannot rewrite receipt
facts or authorize a blind repeat.

## 4b. Judgment-point check

No new static heuristic decides among competing conversational meanings. Finite
protocol states, current ownership proofs, storage results and cryptographic checks
implement named safety invariants. Time and size bounds cap work; they do not claim
that a missing receipt means a rejected external request.

## 5. Interactions

- Shadowing: credential/recording refusal can stop a malformed or unrecordable
  request before admission without a retained operation. Prepared/admitted origin
  holds return nonretryable 409 with their available retained identity, so generic
  5xx handling does not manufacture a second logical operation.
- Double-fire: notices have preclaimed single-owner capabilities and share the
  owner pacing authority. Durable content suppression and logical receipt replay
  are distinct checks; outcome-unknown does not earn a new send.
- Races: workers, owner clients, session revocation, token rotation and browser
  restarts are fenced by incarnation/boot identity and current authority. Late
  configuration work is cancelled or occupies its bounded slot until it settles.
- Feedback loops: browser recovery has a durable episode latch and 15-minute
  brake. Lease renewal uses the existing bounded current-holder timer; dependency
  registration neither acquires ownership nor postpones an already-running tick.

## 6. External surfaces

Telegram users see metadata by default and may hide it without disabling records.
Fixed automation has a named producer and no model; unavailable evidence is
labeled honestly. Media, edits and browser messages preserve protocol-specific
receipt identity, and browser messages retain the agent-authorship signature.
Persistent state includes retained origin/outcome tables, private payload custody,
key history and bounded archives. Network acceptance and peer availability remain
external uncertainties. The original hold-and-notify approval governs application
notice permission; Telegram manages personal client settings.

The Message origins dashboard tab uses existing PIN-issued operator proof for
audit and display settings. Agent defaults and named conversation overrides are
editable without enabling model-selection rollout. Status distinguishes unavailable
records and incomplete peer coverage; technical details are secondary.

## 6b. Operator-surface quality

Build13 actual Chrome at 375×812 verified PIN unlock, all three shared tiles,
audit detail and display save without changing the original record. Save is
visible after opening Display settings (bottom y676.7), with no horizontal
overflow. The final dashboard/profile focused batch passes644 tests, with one
existing skip; phone/profile/native E2E passes11 tests without skips. The HTTP
fixture does not test dashboard WebSocket health.

Cosmetic revisions are compared inside the existing topic-store lock. Display-only
writes preserve parked, breaker and intended model state; model undo/reapply
preserves the latest cosmetic choice. Raw agent config writes preserve encrypted
placeholders and sibling fields, recheck the observed revision immediately before
atomic rename, and preserve file mode. This is not a filesystem compare-and-swap
against arbitrary external writers after the final check. New messages see agent
default changes after the configuration refresh, normally within a few seconds.

## 7. Multi-machine posture

**Proxied-on-read:** immutable machine-local signed evidence is served through
authenticated pool reads with bounded snapshots, strict cursors and explicit
missing-shard coverage. Execution payload custody is machine-local by design: a
peer evidence copy cannot grant the old owner's delivery rights. Conversation
display overrides follow the existing topic-profile transfer path. User notices
require current one-voice ownership. Audit URLs resolve through the active agent
server; missing peer evidence is reported rather than silently presented as a
complete pool. An unavailable former execution owner may require reconciliation;
topic transfer never authorizes blind replay of its uncertain operation.

## 8. Rollback cost

Hiding the footer is a reversible presentation change. Rolling back the enforcing
writer is not an equivalent compliant rollback. Preserve new audit records, key
history and retained queue envelopes when replacing binaries. Incompatible old
writers must not consume new custody records. A defective enforcement release
requires a compatible repair release and verification of migrated live sessions;
users may observe held delivery while that repair propagates.

## Framework generality

Scoped identity is issued through the shared session lifecycle. Per-harness native
observers distinguish Claude Code and Codex formats; unsupported or unavailable
observations remain unknown/configured. No Claude-only assumption is used to
fabricate observations for Codex, Gemini or a future harness. Actual native Codex
launch evidence is available; it is not evidence for an actual Claude CLI launch.

## Detector verification delta

Precommit enrollment checks identified missing Rule 3 rationale/registry entries
for config, notice-policy and native-model observers. The owned contract canary
now exercises real disposable encrypted config, file-key SecretStore and hub
sources at startup and on a completion-relative hourly schedule by default.
The validated interval is 60 seconds through seven days. Each run has at most
two six-second worker attempts; termination and exact private cleanup retain the
single-flight slot until settled. Cleanup uncertainty latches further work.
Unabortable filesystem work can outlast the caller deadline; no hard cleanup
wall-clock guarantee is claimed. Failed runs report local degraded diagnostic
health. Neither the worker nor its health result has a Telegram transport.

The Codex lane runs at most one native diagnostic per cycle with a 30-second work
deadline. An actual installed CLI writes two records using distinct model labels
from an isolated loopback provider; independent native session/turn IDs anchor
parser checks. Child-specific configuration, an environment allowlist and macOS
Seatbelt deny real credential reads, external networking and process forks.
Six actual isolation controls precede the prompt; cleanup ownership is retained.
The diagnostic scope is native-cli-format-with-loopback-provider and explicitly
providerExecutionVerified:false. Other harnesses/platforms remain unavailable.
A local provider fixture is not real provider execution, and diagnostic success
never becomes current-message model evidence or hook/send authority.

Known-source health and isolated canary health remain separate. GET does not
refresh timestamps. Config/notice readers and both canary projections reject
clock reversal; native source health retains its existing observation-age check.
Expiry, failed reads and closed resources remain explicit in their owning health
surfaces. A failed Boot closes already-created readers,
workers and sockets before any diagnostic schedules start. Diagnostic schedules
are per boot; process restarts can trigger another initial probe. No global
restart-surviving lifetime count or cadence is claimed.

Independent review found SecretStore test mode could still query alternate OS
keychain candidates. The repair installs a no-op keychain backend only in test
mode without explicit injected operations; normal production fallback recovery
is preserved. Direct tests exercise getCandidateKeys and encrypted store reads
in both forceFile modes and observe zero OS calls. Historical test-mode trials
may have queried the keychain; their count and success are unknown. No prior
zero-keychain-access claim is made.

Current focused verification passes 60 detector/HTTP/Boot tests and 82 secret,
vault and strict-fallback regression tests. Independent source review found no
remaining material issue. Build13 actual installed native E2E and retained dist
proof pass two distinct matching native turns, all six named isolation controls
and verified cleanup with Codex0.153.4. The coordinated build and lint pass.

## Conclusion

Build13, lint13,644 focused dashboard/profile tests and11 E2E tests pass. The
actual phone browser check passes. The final build13 sandboxed actual
Lifeline/Supervisor/main trial passed all runtime assertions: 135-second continuous
lease, owner and main restart, recovery of both original held operations, retained
receipt identity and duplicate suppression. All 15 isolation controls passed. Its
original cleanup audit failed conservatively on a changed helper identity; a later
independent closure check found no surviving resources. The original failed audit
is preserved, and the overall trial is not described as green. Telegram transport
was a loopback fixture. Config and notice sources were healthy and all six owned
canary checks passed before and after restart. The nested native diagnostic failed
safely under the outer startup sandbox; separate final-dist native proof supplies
its successful format/isolation result. Fourteen pinned compiled hashes remained
unchanged. The first earlier build13 attempt failed its detector predicate without
retaining the exact failing field; the native mismatch is an inference for that
attempt. The second retained samples confirming that its fixture incorrectly
required native unavailable instead of accepting the observed confined failure.
Both original results and independent resource-closure checks are retained.

Run9 stopped on the shared glance adoption failure; that source correction now
passes its focused checks. Build13 and final phone/native validation pass.
Full regression run10 finished its first stage with five failures and 51,678 passed
tests; subsequent command stages did not run. Two obsolete direct-send wiring
assertions now check actual deterministic producer/builder calls, and three
readiness assumptions are corrected by awaiting automatic source observation or
finishing fixture writes before Boot. A related detector E2E wait is also corrected.
The six-file test-only batch passes 39 focused tests across seven files; root review
and all 14 compiled hash checks confirm production build13 is unchanged. Fresh
run11 stopped early after independent review found a test-fixture cleanup gap:
the generationless respawn test writes inbound files into the checkout. A narrow
test-only temporary-directory correction now passes 37 related tests across five
files. Independent review concurs; exact post-test checks found zero remaining
fixture files or directories. Full run12 completed with exit code 0 and zero failures: 51,684 aggregate,
4,179 integration and 3,228 E2E tests passed. These counts overlap across stages.
Existing skips/TODOs are 29/3,12/0 and7/3 respectively. The frozen source
fingerprint and all 14 compiled hashes were verified unchanged after completion. Final build13 startup runtime assertions
pass with the original cleanup failure and independent closure reported separately. Physical peer delivery and
complete signed release evidence remain open. Review concurrence applies to the
implementation and stated evidence boundaries; it is not clearance to deploy.

## Prior second-pass review (before detector and glance delta)

**Concur with the review.** — origin_security_review

The revised class-closure declaration accurately distinguishes direct production
guards from synthetic registry enrollment. No material concerns remain in this
bounded second pass. Reviewed body SHA256 before this review was appended:
`56f40fb7dfef1cc51ac6e7c0b7e869cca209bbbcbf6f60e7d506d0995990cbb8`.

Concurrence covers this artifact and its stated evidence boundaries. It does not
certify full-regression success, overall trial cleanup success, physical-peer
coverage, signed release completeness, operator commit approval or rollout readiness.

## Evidence pointers

- [Current conformance](../../docs/specs/reports/telegram-message-origin-conformance.md)
- [Exact validation index](../../docs/specs/reports/telegram-message-origin-evidence/current-validation.json)
- [Approved spec](../../docs/specs/telegram-message-origin.md)

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`; `closure: guard`, scoped to recovery of
an original admitted child/operation, with shared profile pacing.

`guardEvidence.enforcementType: ratchet`; primary citation:
`tests/unit/telegram-origin/browser-recovery.test.ts`. Its real worker restart
checks the persisted floor (899,999ms denied; 900,000ms allowed), stale-fence
refusal, episode continuity and cooldown re-arming after cached-process failure.
The control-loop edge is failed browser canary → bounded activation attempt.

The finite retry bound is separately exercised by
`tests/unit/telegram-origin-store.test.ts` (actual per-child claim ceiling across
boot identities) and `tests/unit/telegram-origin/known-failure-retry.test.ts`
(ninth-attempt and original-deadline exhaustion). The real executor/broker/outbox
composition in `tests/e2e/telegram-origin-browser-outbox.test.ts` verifies one
fresh-process retry, zero transport invocation on failed canary, retained attempt
count, and a persisted 15-minute floor that blocks another driver after restart.
The production executor retains the original nine-attempt/six-hour budget and
claims before invoking the broker. These guards detect loss of the original-work
retry ceiling or persisted settling brake; receipt uncertainty grants no new send.

`tests/unit/self-action-convergence.test.ts` provides structural enrollment for
`telegram-browser-canary-recovery`. Its synthetic model imposes its own counter;
it is not proof of the production retry budget or brake. This declaration makes
no global lifetime-count claim across endlessly new authorized operations. The
mirror will be copied into the reviewed commit trace and does not assert that
full regression has already passed.

The separate detector cycles use `telegram-origin-owned-detector-canary` and
`telegram-origin-native-model-canary` registry entries with infinite lifetime
counts and an explicit per-instance recurrence floor. Their direct guard is
`tests/unit/telegram-origin-canary-scheduling.test.ts`: actual controller classes
hold single-flight work, wait at least the configured interval after completion,
perform at most two owned attempts or one native adapter call per cycle, stop on
close and intentionally probe afresh after reconstruction. The test injects
attempt/adapter outcomes; actual worker encryption and native parsing have their
own detector/HTTP/E2E proofs. No synthetic registry counter stands in for these
production scheduling assertions. A server restart may trigger another immediate
probe, so this is no global restart-rate or lifetime-count certificate.
