# Telegram message origin — implementation conformance

Status: **implementation incomplete; not deployed; runtime-compliant: false**.

This is an implementation checkpoint for `feat/telegram-message-origin-completion`, based on
`77df8be`. The prior `feat/telegram-message-origin` worktree remains frozen after
its full-suite run; all subsequent implementation is in the completion worktree. Passing a row below proves the stated fixture boundary, not fleet
enrollment or authenticated browser operation. The approved spec remains the
acceptance authority. No activation or complete sender coverage is claimed.

## Release repair validation, 2026-09-08

Merged main v1.3.1229 into the completion worktree and repaired the host-binary
triage fixture plus automatic canary restart bursts. Both automatic canaries now
wait 60 seconds after startup or reconstruction before their first cycle, then
recur after completion. Existing-agent awareness is refreshed idempotently.
Justin approved exactly 36 deadline extensions to September 14; an independent
date-only family review refreshed the three affected content-bound audit records
without changing any coverage floor or claiming the unfinished guards exist.

Final `npm run test:all` exited 0 with zero failures: 51,762 aggregate tests,
4,181 integration tests, and 3,229 E2E tests passed. Counts overlap across stages;
existing skipped/TODO tests remain explicit. Build and lint passed. See
`upgrades/side-effects/telegram-origin-release-repair.md` for exact counts, the
full-log hash, independent reviews and failed/stopped attempt history.

The older fingerprints and runtime trials below remain historical evidence for
their original source. They are not silently rebound to the repaired source.
Physical cross-machine proof and signed complete release certification remain
unfinished; a package release does not certify full fleet activation.

## Historical validation snapshot, 2026-09-07 00:18 PDT

Build13 and lint13 pass. The staged migration-consumer, Rule 3, migration-protection
and E2E-pairing checks pass. The final guard batch passes 176 tests across four
files, including awareness delivery, strict fallback baseline and Stage B binding.
The commit review gate still awaits its deliberately deferred fresh final trace.
Full run9 stopped on missing shared dashboard glance adoption after 84 files
passed. That source correction passes all dashboard unit checks (392 tests).
Final phone/native E2E passes. Build13 startup runtime assertions pass with
independent closure; its original conservative cleanup failure remains recorded.
Full run10 ended after its first stage with five failed tests and51,678 passed
tests (3,336 passed files). Integration and E2E command stages did not start.
Failures are two obsolete direct-send wiring assertions, two observer-readiness
assumptions, and Threadline attribution during fixture config invalidation.
Confirmed reproductions support test-only corrections, including a directly
related E2E readiness wait. The first six-file correction batch passed focused checks. Run11 stopped early
when independent review found that a respawn fixture leaves inbound history in
the checkout. Both routing fixtures now use temporary inbound directories, clean
with SafeFs after routing settles, and leave no fixture files behind. The related
37-test/five-file batch and independent review pass. Full run12 completed with exit code0 and zero failures across all three stages:
51,684 aggregate tests,4,179 integration tests and3,228 E2E tests passed. Counts
overlap across stages. Existing skips/TODOs remain29/3,12/0 and7/3 respectively.
The final source fingerprint and all14 compiled hashes still match the frozen batch.

Current source fingerprint:
`9111d69153983a33b9ad2b435f4131014059dcd021bdd7fb9bffe1c75f22dd4b` (5,568 files).
The fingerprint changed only for the six test corrections. All 14 checked compiled
files still match build13; its historical runtime evidence remains bound to its
original fingerprint. Focused correction checks passed 39 tests across seven files.
The phone tab now uses three shared tiles: Display settings, Recording status,
and Recent messages. Build13 actual Chrome375×812 verifies all tiles, PIN, audit and save; Save is
visible after opening Display settings with no overflow. Final focused checks
pass644 tests (one existing skip), and11 E2E tests pass without skips. Cosmetic writes preserve model rollout, lifecycle and undo semantics.
The HTTP browser fixture does not test dashboard WebSocket health.

The new detector checks pass 60 detector/HTTP/Boot and82 secret/fallback tests.
Independent source review accepted test-mode keychain isolation, failed-Boot
cleanup, native process-fork denial and explicit diagnostic scope. A further176
registry/scheduling checks pass. Fixed-cost cycles have a per-instance recurrence
floor, not a restart-surviving lifetime limit. Codex verification uses an actual
installed CLI with a loopback fixture; real-provider execution and other harnesses
remain explicitly unverified. Source health, hook proof and canary results do not
authorize a message or supply observed evidence for that message.

The original hold-and-notify authorization is sufficient; no notification-policy
approval is pending. Current Instar permission and credential ownership govern the
configured operator hub; Telegram manages personal client preferences. Both the
main initializer and independent notice observer resolve encrypted SecretStore
configuration, with bounded cancellation and token-rotation revocation.

Completed focused checks include 50 notice-policy tests, 273 notice/producer and
affected-component tests, 163 lease/migration checks, 46 registry/token isolation
checks, 21 release-issuer/enrollment checks and three production enrollment E2E
checks. Groups overlap and are not a unique suite total. The final sender source
review found no enabled unrecorded bypass in the reviewed families; this does not
certify deployed fleet coverage.

The actual installed historical relay was migrated and executed as a Bash
subprocess against the production routes, encrypted fixture configuration and
SQLite. Visible and hidden sends retained concrete loopback receipts after reopen;
missing, foreign and revoked credentials were rejected without extra sends. The
final runner exited cleanly. A separate real-time default-lease test retained the
same lease epoch after its 60-second TTL, with actual renewal timers and accepted
HTTP delivery after 65 seconds. Neither trial sent external Telegram messages.

The final build13 sandboxed actual Lifeline/Supervisor/main trial passed every runtime
assertion with 15 passing isolation controls: continuous same-epoch lease for
135 seconds, stale owner grant refusal, actual main restart, recovery of both
original held operations, unchanged original receipt and duplicate suppression.
The original cleanup audit failed conservatively on a changed helper identity;
a separate later closure check passed with no surviving resources. The original
failed audit is preserved; the overall trial is not called green. Telegram used
loopback substitution. Config/notice health and all six owned-canary checks passed
before and after restart; nested native diagnostics failed safely under the outer
sandbox, with separate final-dist native proof supplying success evidence.
Fourteen compiled hashes remained unchanged. Two build13 attempts retained their
failed fixture-health predicates and independently verified resource closure.
An earlier diagnostic attempt escaped environment-only
isolation through a task LaunchAgent; exact owned resources were removed, but
provider requests and ordinary global registry pruning remain unknown. Final
trials use inherited kernel restrictions and a private tmux socket.

Production enrollment now supplies live peer, producer, census and trial
observations. The explicit `release:certify-telegram-origin` command verifies
reviewed evidence and final package bytes against pinned signing authority;
ordinary builds never manufacture certification. Both physical peers are reachable
on v1.3.1226 but have no origin endpoint or established isolated executor. A real
cross-machine trial and complete signed release certification remain open.
Aggregate readiness cannot bypass per-operation recording or authorization.

`telegram-message-origin-evidence/current-validation.json` contains exact logs,
source identity, failed/stopped attempts and completed bounded trials. Production
activation remains false. The tables and dated checkpoints below preserve history;
remaining items are superseded only by later explicit evidence.

## Sender coverage

| Sender / obligation | Production implementation | Executable evidence | Remaining obligation |
| --- | --- | --- | --- |
| Session HTTP replies | SessionManager lifecycle, OriginSessionRegistry, RuntimeOriginObserver, reply middleware, template credential forwarding | origin-session-registry, session-manager-origin-lifecycle, runtime-origin-observer, telegram-origin-routes | Live installed-script trial; native runtime fixtures cover known harness formats, not every deployed version |
| Direct Bot API / adapter / DM | telegram-egress → OriginBotEgress → TelegramOriginService → canonical outbox | origin-service, telegram-origin-runtime-lifecycle | Fresh sender census and startup enrollment gate; unbound callers are explicitly unknown |
| PresenceProxy author | Per-call OriginAuthorCall capture, internal body/destination-bound one-use credential, ordinary HTTP reply route | automation-author, telegram-origin-routes, telegram-origin-production-boot | Broader automation author enrollment; selection callback is configured evidence, not native observed evidence |
| Deterministic notices | Explicit deterministic author for rate-limit/silence/heartbeat/resume callbacks | automation-author and HTTP credential controls | Positive controls for every producer family, including indirectly composed conversation-funnel messages |
| Lifeline | Production runtime boot, independent fixed-notice IPC owner/client, same Bot boundary | telegram-origin-runtime-lifecycle | Full real Lifeline/main restart trial and peer evidence fallback from Lifeline |
| Tokenless mesh | Signed MeshRpc protocol, source evidence-only persistence, owner outbox and receipt | telegram-origin-mesh | Fleet rolling negotiation, original conversation-store logging, end-to-end handoff trial |
| Owner handoff | Immutable executionOwnerMachineId; successor refuses old plan before admission | telegram-origin-mesh successor refusal | Operator resolution path for genuinely unavailable old-owner custody |
| Durable origin redrive | Existing DeliveryFailureSentinel invokes bounded runtime recovery, original IDs/deadline/plans retained, uncertain children excluded | origin-service, telegram-origin-runtime-lifecycle | Legacy queued rows/session credential migration; live browser recovery trial; known-failure retry scheduling |
| Captioned Bot media | Caption footer planning and media visibility classification | bot-media-contract, origin-service, actual development attachment receipt | Remaining formatted-caption boundary variants |
| Captionless Bot media / group | Immutable companion child; one allowed receipt-binding derivation; actual reply link; hidden mode has no companion | origin-service, telegram-origin-runtime-lifecycle | Nested-caption presentation; live attachment trial; file uploads now have atomic outbox byte custody and exact multipart recovery |
| Forward/copy | Source message references retained separately; destination receipt validates documented MessageId/Message shapes | origin-service, bot-media-contract | Live skipped-source trial; confirmed subset is now retained and indexed while the remainder stays outcome-unknown |
| Edits | Original namespace lookup and editor revision link | origin-service | Inline edits and every streaming/fallback path |
| A2A / Threadline | Per-call A2A author capture; forwarded peer/source authorship stays explicitly unknown unless a submitting private context exists | 66 unit/HTTP checks and production-factory author E2E | Remote author evidence protocol and broader producer census |
| Setup/demo/raw shell | Setup CLI greetings now use a fixed server-authored HTTP operation; configured demo bots enroll with separate credentials and account-bound recovery | codex-playwright-telegram, telegram-origin-routes, production boot | Complete test-as-self/raw-shell enrollment and installed-template census |
| Operator Web K | Profile exclusion, private CDP pipe, typed broker/executor, build/account canaries, ASP and concrete receipt | telegram-origin-browser, telegram-origin-browser-outbox, runtime bootstrap | Existing profile enrollment and writable-process revocation; authenticated live canary/send; durable reload/attention episode brake (in-process single reload is implemented) |
| Public MTProto alternate | Enrolled transport worker and same broker contract exist | Browser transport fixtures | Production enrollment/activation and recovery wiring |

## Binding, durability and observability

| Obligation | Implemented evidence | Limits still requiring work |
| --- | --- | --- |
| Canonical immutable origin / request | Strict canonical JSON, request and envelope digests, machine attestation, source identity verification | Additional hostile relay parameter/plan budget controls and full fleet negotiation |
| Preparation credential lifecycle | Hash-only session registry, incarnation replacement, liveness, revoke, bounded population; failed older issue cannot delete newer issue | Concurrent persist-failure regression and live process enrollment trial |
| Automation credential | In-process mint only; exact HTTP body and topic; 30-second expiry; one use; bounded to 1000; raw token not persisted | Expiry/capacity positive and negative lifecycle tests; all producer enrollment |
| Author distinction | Per-call resolved model/framework are configured; missing provider model is unknown; discarded model result cannot author a fixed fallback; concurrent calls isolated; PromiseBeacon carries author evidence through the conversation funnel and durable aggregation | Remaining producer families and remote-author protocol binding |
| Durable-before-send | Primary worker FULL SQLite, independent evidence spool and inert peer receipt; only canonical PendingRelayStore grants claims | More total-outage recovery cases; attachment bytes now commit in the canonical outbox and survive process restart |
| Uncertain acceptance | Correlated concrete receipt; lost/invalid response is terminal to generic retries; restart excludes dispatched uncertainty | Durable diagnostic findings and reconciliation consumer; partial group evidence is now retained |
| Fixed outage notice | Pre-recorded/preclaimed variants, one owner capability, fixed hub-only IPC, bounded timeout, no original replay, startup outage cannot restore old permit | Production application-permission projection under implementation; shared owner pacing implemented and tested |
| Display defaults / overrides | Four true defaults; explicit false preserved; existing topic-profile validation and transfer flow; display snapshot frozen | Live cross-machine preference convergence and operator UI audit flow |
| Retained origin lookup | Indexed account/chat/topic/message namespace, editor links, every fully accepted album receipt indexed | Body-free receipt audits for remaining transport variants; retirement preserves store archives and public-key epoch history |
| Pool audit | Bounded authorized shard reads, opaque cached pagination, frozen upper sequences, deduped evidence copies, missing shard reporting | Live multi-machine coverage; strict cursor progress, frozen page bounds, source-timestamped pool metrics and signed query-bound assertions are implemented |
| Metrics | Transactional idempotent events/counts; unavailable store reports stale/unknown, never fresh zero | Full prepared/held/suppressed sender denominator and pool aggregates |
| Archive | Bounded immutable SQLite archive with digest/count manifest; indexed reads remain; payload cleanup separate | Live retirement/restore trial; maintenance performs bounded cleanup and 30-day archival, with retained audit/key history |
| Machine-local custody | Shared prefixes feed FileClassifier, BackupManager, fresh GitStateManager ignore list and PostUpdateMigrator; SQLite sidecars included | Existing accidentally tracked files must be audited before rollout |
| Awareness / migrations | Shared fresh/existing awareness; config defaults; reply script refresh; topic-profile display field | All installed shell/browser templates, production activation matrix and maturation registration; framework shadow awareness and diagnostic registries are now enrolled |

## Validation checkpoint

Completed focused batches include 67 author/HTTP/outage checks, 167 browser-route
and local-custody checks, media/forward/mesh/runtime checks, and a production-factory
test with real config, identity, workers, stores, session lifecycle and internal
HTTP submission. External Telegram calls are mocked in these tests.

The first aggregate full-suite run completed with 13 failures across 10 files
(51,236 passing tests). The second completed with 10 failures across nine files
(51,283 passing tests). Their causes were addressed in the completion worktree;
161 focused manifest/parity/shutdown checks and 53 diagnostic registry checks passed.
A clean final `npm run test:all` is still required; targeted
reruns are not a substitute. Preflight also identified a missing routing-registry
row for `telegram-origin-recovery`, now added with its actual bounded diagnostic
role. No claim of a green final suite is made until a complete rerun finishes.

Authorized development trials passed for text, hidden-display persistence,
attachment and browser account send with actual correlated Telegram receipts.
The cross-machine relay trial remains required. No fleet activation may rely solely on these fixture results.

Primary receipt/format references used while implementing media support:
[Telegram Bot API](https://core.telegram.org/bots/api#sendmediagroup),
[forwarding](https://core.telegram.org/bots/api#forwardmessages),
[copying](https://core.telegram.org/bots/api#copymessage).

## Completion-worktree checkpoint

- Browser transport: bounded private-pipe requests (32 concurrent, 1 MiB each,
  30-second default), minimal child environment, bounded serialized reads,
  retired late-start drivers, one fresh-process canary retry. Recovery now uses
  a durable activation fence and fifteen-minute floor plus FailureEpisodeLatch;
  attention acceptance is persisted, and pending attention remains inspectable.
  Two distinct failed build
  IDs expose the public-transport alternative; repeating one build does not.
- Multipart: immutable Blob snapshots, signed file refs and multipart digest,
  atomic SQLite payload custody, 50 MiB/file and 64 MiB/operation upload bounds,
  ten-file ceiling, exact restart recovery, payload-only cleanup. A test with a
  real file exposed and fixed the old FormData snapshot discarding file bytes.
- Browser signature renewal: the original six-hour operation survives the
  780-second ASP dispatch window. Renewal changes only the signed tag and
  dispatch deadline; stored content/destination/random-ID substitutions are
  refused before claiming. Owning signer loss holds the original operation.
- Peer audits now require the existing pool-link operator assertion format,
  bound to issuer, recipient, query digest and a ten-second lifetime. A fixed
  1,000-slot durable nonce table reuses expired slots and never evicts live
  replay fences. Merely signing a mesh request does not grant audit access.
- Recovery diagnostics are registered in provenance, parser, untrusted-input,
  claim-judging and injection-exposure censuses. The benchmark exemption matches
  the existing advisory-dashboard posture: opaque diagnostic text has no
  parsed verdict or execution authority; no benchmark-derived model-routing
  claim is made.

Focused validation: 221 initial registration/browser checks, 31 pipe/browser
checks, 99 upload/visibility checks, 48 renewal/browser/runtime checks, 39
retention/partial-receipt checks, and 53 diagnostic-classification checks passed.
These overlap and are not a unique-test total. The frozen full suite found
additional missing diagnostic classifications (fixed in this worktree) and
a stale generated builtin manifest (regenerate after template changes).
A new full run against the final completion worktree is still required.

## Recovery and enrollment checkpoint, 2026-09-06 afternoon

- The combined origin tests passed: **167 tests in 21 files**. Subsequent pool
  metrics/mesh/recovery checks passed 28 tests; these overlap the combined set.
- Legacy queued and ambiguous rows migrate atomically in place, retaining the
  original deadline, delivery ID, attempt count and next-attempt time. Unknown
  author fields remain unknown; an explicit importer attests custody separately.
  Incomplete transport history stays outcome-unknown. The old startup purge and
  legacy redrive are disabled whenever origin recovery is installed. Existing
  redaction and tone review still apply to definitively unsent legacy work.
  Claimed legacy rows now import as outcome-unknown too: conversion fences the
  old worker's queue transitions without granting a new delivery attempt.
- Recovery diagnoses now reserve a durable per-origin consult before invoking
  the shared LLM queue, and store bounded advisory text on the audit record.
  Restart cannot duplicate the consult; diagnostics have no resend authority.
  A concrete receipt-probe consumer remains to be completed.
- Definite Bot API 429 refusals and recoverable pre-dispatch browser failures
  schedule through the existing backoff table and original outbox. Unknown
  external acceptance is never scheduled. Audit attempts retain failure reasons
  and next-attempt times.
- Nested album/edit-media captions now carry the footer; fully captioned albums
  avoid an unnecessary companion. Entity offsets remain unchanged. Multipart
  sealing includes the final captions. Live attachment proof remains required.
- Conversation-filtered audits now include prepared/held work through an indexed
  destination table, not just confirmed platform receipts.
- Pool metrics use a distinct one-use operator assertion audience. Source
  evidence is counted only on its source shard, while execution counts come
  from the sole outbox. Missing shards return cached counts marked stale, or
  unknown counts if no sample exists; archive transitions preserve totals.
- Runtime installation closes the legacy Bot egress bypass on tokenless peers
  too. The standalone test-as-self probe loads the existing target identity and
  runs through the same outbox. Claude/Codex tool hooks reject direct raw Bot
  writes, Telegram MCP sends and generic access to managed browser profiles.
  These are cooperative tool boundaries, not an operating-system sandbox.

## Installed coverage and author checkpoint, 2026-09-06 afternoon

- **40 checks passed** across per-call authors, PromiseBeacon, its durable
  aggregate/funnel, HTTP replies and the production bootstrap. A mixed-model
  aggregate keeps each contributor's evidence (bounded to 128, with explicit
  omission counts) and never credits the last caller for the whole batch.
  Fixed fallbacks remain model-not-applicable; unbound generators remain unknown.
- The activation conjunction requires all twelve named obligations plus a
  complete enabled-writer inventory. Missing, stale, conflicting or held rows
  prevent a complete claim. Production inspection checks actual relay bytes,
  installed Claude/Codex wildcard hooks, current session bindings, browser profile
  ownership and a fresh compatible Lifeline lease. It does not infer the unseen
  peer/census/trial obligations. **55 checks passed** for activation/legacy/mesh/
  HTTP/boot, followed by **45 installed-enrollment and lifecycle checks**.
- Web K checks now hash the public JavaScript bytes, with bounded reads, rather
  than treating a bundle filename as content proof. A concrete page-script
  fixture exercises account switches and changed bytes immediately before send;
  **38 browser/driver/outbox checks passed**.
- The first live read-only inspection failed before principal verification.
  After fixing navigation context replacement, the same existing profile passed
  authenticated account and exact bundle-byte checks. Exclusive enrollment found
  no pre-existing writable browser process to retire. No personal profile was
  touched. Evidence: `telegram-message-origin-evidence/authenticated-web-k-canary.json`
  and `browser-exclusive-enrollment.json`.
- Four permitted live development messages were accepted: bot text (70944),
  hidden footer (70945), attachment (70946), signed operator browser message
  (70947). Every transport invocation followed a durable dispatched attempt.
  A fresh worker read all four accepted records after process restart. The
  browser inbound path identified the returned message as agent-signed.
  Model evidence is **configured**, harness evidence **observed**. These used
  an isolated development outbox and do not certify production deployment.
  Evidence: `telegram-message-origin-evidence/live-delivery-trial.json`.
- Fresh source discovery found 54 candidate files using Telegram URLs or sender
  calls, including non-sending declarations and lint fixtures. This is a search
  denominator, not complete sender-family proof. The live profile registry now
  records broker ownership; native harness installation and fleet activation
  remain unverified.

Remaining activation obligations include a fresh sender census and startup gate,
existing browser-profile/process enrollment, authenticated live development
trials, producer-family author evidence, complete key/alias lifecycle and verified
retirement/export. Earlier table gaps superseded by the implementations above
are implementation checkpoints, not a claim of fleet activation.

## Independent review fixes, 2026-09-06 17:16 PDT

This remains an uncommitted development implementation, not an activated fleet
feature. Live text, hidden-display, attachment, and signed browser trials have
durable receipts retained across a fresh worker restart; the public evidence is
`telegram-message-origin-evidence/live-delivery-trial.json`. Read-only signed peer
capability probes did not establish remote readiness (`peer-readiness.json`).

The latest independent reviews found and corrected these additional boundaries:

- Admission attestation now covers deadlines, attempt budgets, payload descriptors,
  child materializations and permitted derivations; changed execution bounds fail
  before admission or network dispatch.
- Recovery preserves healthy workers during in-flight receipt waits and advances
  a durable bounded cursor past held candidates. Memory-held candidates rotate;
  expiration releases live capacity while retaining bounded diagnostic history.
- Existing stock relay scripts migrate using their pinned historical SHA. Their
  ambiguity messages preserve the original operation instead of suggesting a
  fresh submission based on absence of matching conversation prose.
- Browser, source relay, holder and recovery paths use the existing send-policy
  authority. Original review input and advisory reactions are protected with the
  operation; caller-supplied exemption flags cannot authorize a bypass.
- Batch and beacon retries preserve origin holds across restart. They consult
  receipts for the original operation before advancing; unresolved acceptance
  never becomes a newly prepared send. Held batch bodies use the existing
  machine-local custody prefix rather than replicated suppression metadata.
- Worker input has an aggregate byte bound; archive pages verify each file once
  per request and bound accumulated output. Late browser profile directory aliases
  are refused at use. Pool pages reject non-progressing cursors and duplicate rows;
  metrics preserve source timestamps and reject stale or future samples.
- Boot no longer fabricates unmuted/unarchived/not-deleted/not-opted-out destination
  state. Without an independent fresh authority projection, outage notifications
  are unavailable and activation remains incomplete.

Focused results at this checkpoint: 90 passing tests in routing, installed hooks,
relay script output and runtime lifecycle; 61 passing tests in custody restart,
batching bounds and actual package contents; 64 passing shared-policy and
production-factory notice tests reported by the security reviewer. Lint passed.
The full suite run started before these edits is diagnostic only and has failures;
it is not a final green result. A complete run on stable final sources is required.

The optional receipt witness was withdrawn after independent review confirmed
that outcome-unknown after persistence failure is permitted by the specification.
Neither blocked source edit ran; no witness cleanup or cleanup approval is needed.
Full sender coverage and cross-machine deployment trials remain outstanding.


## Validation and remaining decisions, 2026-09-06 17:44 PDT

The native hook boundary now distinguishes current script execution from actual
CLI configuration loading. SessionManager captures the settings digest only at
real CLI launch; re-enrollment cannot manufacture this proof. The native listener
fixtures and generated guard execution passed 75 checks across eight files; a
live replacement CLI trial is still required.

Ordinary sends and outage notices now share credential-owner pacing through the
existing authenticated IPC. Expired credits cannot dispatch captured closures;
pre-dispatch cancellation restores only unspent attempts. Final capacity checks:
27 tests plus one notice-revocation race, with additional service/runtime coverage.

Notification batches freeze and persist exact text, count and logical identity
before delivery, and serialize flushes. A real runtime restart test observed one
network send and one durable origin after the upstream return was lost. Unsupported
send dependencies hold uncertainty instead of issuing an unsafe fresh retry.

Beacon response-loss recovery uses the same private logical identity and frozen
body after restart. A previously delivered heartbeat cannot satisfy a later
close-out: the old receipt advances its sequence and the distinct close-out gets
a new identity. The Beacon and service checks passed 46 tests across two files.

Historical signing-key epochs and first verified acceptance evidence are retained;
current revocation prevents new acceptance without erasing historical validity.
Source machines can resolve receipts only from the sealed original owner, without
redirecting or resubmitting the message. Focused tests cover both boundaries.

The first aggregate suite finished with 61 failing tests in 17 files and one
unhandled error while source edits were still underway. Subsequent focused fixes
have passed, but this does not establish a green full suite. The required complete
command must run again on stable sources.

N5/N6 currently require positive knowledge of personal Telegram mute/archive
settings that Bot API cannot expose. No production observer exists, and a hub ID
is not evidence of those settings. A decision has been requested: preserve that
strict rule by adding an operator-account reader (unavailable to bot-only agents),
or use Instar notification permission while Telegram applies recipient settings.
No permission has been inferred and notifications have not been declared ready.


Receipt-witness scope correction: independent review verified that specification
lines 138/140 explicitly permit outcome-unknown after outcome persistence fails,
with no blind retry. The witness is optional resilience, not an acceptance gate.
The blocked cleanup enhancement is omitted; no cleanup ran and no approval is
required to retain the specified safe behavior. The existing response-persistence
fault test verifies one network invocation. Automatic surviving-process receipt
reconciliation remains an optional improvement, not a claimed implementation.
This historical notification-policy question was withdrawn by the authorization correction below.

## Stable-source validation, 2026-09-06 19:03 PDT

The third completion-worktree aggregate run finished on frozen sources:
3,316 files and 51,530 tests passed; one guard test failed; four files and 29 tests
were skipped, with three todo tests. No unhandled errors were reported. The
command exited 1, so its dedicated integration and E2E stages did not run.
The failure was the silent-fallback count (501 versus 496), traced to three
already-observable/control-flow paths and three SQLite error paths requiring
diagnostics. That correction is now underway; a new full run remains required.
Exact fingerprint and log are in `telegram-message-origin-evidence/current-validation.json`.

Two real Codex 0.153.4 launches produced native hook-context records observed by
the production listener. The first launch was ready, replacing its isolated hook
settings made it unverified and require restart, and a fresh launch restored
readiness. No transcript events were synthesized. This closes the actual local
Codex guard-load trial, not every supported harness or fleet installation.

Four actual Node processes exercised production `bootTelegramOrigin` owner/client
roles with shared SQLite and Unix IPC. Owner loss held a message without transport;
replacement owner rejected old capacity, reconnected the surviving client and
recovered the original operation once. A client restart reused its accepted
receipt without another send. Exactly three sends reached a substituted loopback
HTTP transport. Full Lifeline/Supervisor/server-entrypoint startup is still
unverified. Both private trial evidence paths are indexed in current validation.

The final pre-run producer fixes also cover reminder replay using durable event
identity, scheduler origin holds that bypass generic topic-recreation recovery,
and triage authors bound to the composing call or enrolled runtime session.
Focused reminder checks passed 65 tests across seven files; final durable-event
HTTP checks passed 23. Scheduler checks passed 13 unit tests and one production
factory lifecycle test. Triage checks passed 261 unit/integration tests and one
production-factory E2E recording four distinct authorship outcomes.

At this checkpoint, production activation remained false and notification projection, full startup verification and cross-machine readiness remained unresolved. The authorization correction and later validation below supersede the notification question.

## Authorization correction and completion work, 2026-09-06 19:27 PDT

The original operator instruction already authorized holding the message and
notifying the user. Personal mute/archive inspection was an extra restriction
added by the agent to the draft after that instruction, not a user constraint.
The additional approval question has been withdrawn as unnecessary; no reply
or permission was inferred from elapsed time. The implementation now being
completed uses independent current Instar application permission and ownership,
with Telegram responsible for private client settings. The one recorded notice
attempt and ambiguity rules remain unchanged.

The silent-fallback correction passed 124 tests across seven files, TypeScript,
build and lint. The next full run was intentionally stopped with exit 130 and
no reported failures so the notification correction can join the next frozen
source snapshot. This stopped run is not green validation.

A test-only registry path resolver is being validated to enable a safe full
Lifeline/Supervisor/server startup trial. A bounded production collector is also
being added for activation observations that previously had no production
provider. Missing real certification or peer proof must remain explicitly
unknown. Aggregate activation stays diagnostic-only; existing per-operation
recording and authorization gates continue to enforce sends.
