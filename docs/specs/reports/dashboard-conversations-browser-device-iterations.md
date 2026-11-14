# Iteration log — dashboard-conversations-browser-device

## Round 1 (2026-11-08 03:18Z)

- Internal reviewers: security, scalability, adversarial, integration, decision-completeness, lessons-aware — Claude subagents on the authoring session's model (claude-opus-5-5).
- Standards-Conformance Gate: ran, degraded (`no-intelligence`), 0 flags, not authoritative; lessons-aware engaged the registry directly.
- Cross-model: codex-cli:gpt-6-astra — ok (verdict SERIOUS ISSUES). Body hash f3c0c2fc…
- Gemini: not installed. Clean-door claude-code: not enabled on this agent.
- Design findings (after grouping duplicates): 31 raised → 12 themes:
  1. PIN approval broke the existing "PIN never approves on a Telegram-owner agent" rule; PIN is agent-readable (DC-1, LES-2, SEC-1) → approval follows `approvalPath()`; pending browser; DM/Face ID/PIN as for phones.
  2. Cached operator session reuse (SEC-3) → PIN asked at every setup; one setup per session.
  3. Lost setup response, orphan devices, caps, no owner notice (codex, ADV-3, DC-2, SEC-7) → enrollmentId idempotent retry, `replaces`, ≤10 browsers, 6/h, activation notice.
  4. `browserPublicKey` readers missed — `buildSignedOrigin` would have stored no origin (ADV-1, LES-1, SEC-4, INT-1, INT-2) → reader table + ratchet test + new registry methods.
  5. Browser could revoke any device (SEC-5, factual error) → own id only.
  6. Notify-token branch bypasses allowlist (LES-5) → refuses browsers.
  7. Loopback rule only in multi-route mode; tunnel Host spoof at enrolment (SEC-6, LES-8) → both modes; forwarding headers refuse.
  8. Key wiped on transient 401s; tunnel moving machines (codex, ADV-2, DC-3, INT-3, INT-4) → status route with ledger-definite revocation; clock offset; never wipe on guesses.
  9. 30 s re-render clobbers chat; stacked timers (SCL-1, LES-4, ADV-5) → dispose + self-refreshing page hooks.
  10. Polling: events 404 for unreplicated pool convs, pool fan-out every 5 s, media retries, multi-tab budget, cadence mis-classified (SCL-2/3/4, ADV-6, DC-5) → one poller per browser, 60/min budget, backoff, local re-reads, 404 fallback, media cache.
  11. `blob:` of attacker-supplied HTML/SVG runs as the dashboard (SEC-2) → fixed viewable type list; everything else download-only.
  12. Mirror wording incomplete; `redacted` verdict missing; live proof thin (DC-4, INT-5, codex, LES-6) → full wording table; five verdicts; harness matrix incl. Slack.
- Left behind (precision): SCL-5 (lazy media — adopted anyway), SCL-6/7/8 (adopted), DC-6/7/8 (adopted), ADV-7 (adopted), ADV-8 wording (adopted), ADV-9/10 (adopted), INT-6/7/8 (adopted), SEC-8 (adopted), SEC-9 (adopted), LES-7 (folded into 10), codex downgrade-test precision (adopted as a test).

## Round 2 (2026-11-08 03:28Z)

- Internal reviewers: all six (claude-opus-5-5 subagents). Standards-Conformance Gate: ran, degraded (`no-intelligence`), 0 flags, not authoritative. Cross-model: codex-cli:gpt-6-astra ok (SERIOUS ISSUES), body hash f6bb74d7…
- Round-1 themes: confirmed resolved by security (12/12 in text), scalability (SCL-1..4), lessons (LES-1,2,5,7,8; LES-4 reopened as LES2-2), integration (INT-1..3; INT-4 partial), decision-completeness (DC-1..8), adversarial (4/6; 2 reopened).
- Design findings: security 2, adversarial 4, scalability 0, integration 6, decision-completeness 3, lessons 2, codex 3 → grouped into 11 themes:
  1. Agent-written /view pages share the origin, can use the browser key (SEC2-1) → §4.12 sandbox for /view, form-post unlock, HTML-route ratchet.
  2. waitingPhones filters on publicKey → Approve tap/Face ID can't see browsers; introducer approval undecided; DM helper (SEC2-2, INT2-1) → reader table rows, one-waiting rule, introducers refused, shared DM helper.
  3. Activation notice: not raised at all activation sites, no action schema, dropped without Telegram (DC2-1, INT2-2, LES2-7, SEC2-5) → raiseBrowserActivated like raiseLockedSecurityItem at all three sites; link not button; honest best-effort.
  4. Tunnel move: duplicate-key vs one IndexedDB record (ADV2-1, INT2-3, codex) → one key per machine; `elsewhere`; new key + signed `replaces` + forwarded revoke.
  5. `replaces` unauthenticated and lost on Telegram path; blocked at cap (ADV2-2, codex) → signed by old key, stored on pending record, exempt from cap.
  6. Console lifecycle: async pages, rebuild on query change, homeRun (ADV2-3, LES2-2, INT2-6) → ctx.onDispose with navigation token, onQuery, self-refreshing, homeRun moved.
  7. Single poll lock starves other conversations (ADV2-4, codex) → leader polls union of announced conversations; list refreshed by leader only.
  8. Retry consumed session/bucket (DC2-2, SEC2-4) → retry answered before session/charges.
  9. Caps evidence wrong; MAX_PENDING sharing (DC2-3, LES2-1) → maxBrowsers default 10 as judgment-candidate with owner arbiter; rate bounded by ledger growth; browsers excluded from MAX_PENDING.
  10. Standard A marker wrong for tunnel-bound (INT2-4) → justification restated as phones' approved posture (mobile-device-keys.md, 1776c2ed3).
  11. lastSeenAt has no carrier (INT2-5, SCL2-1, LES2-5) → registry.touch once a minute.
- Precision adopted in passing: SEC2-3 header prefixes, SEC2-6 isCurrent switch check, LES2-3 denylist wording + contract test, LES2-4 elsewhere/not-found + bounded retry, LES2-6 named surfaces + BLOCKED rows, ADV2-5..8, DC2-4..8 (vault://demo, harness drivers, expiresAt, media shape), INT2-7 wording sites, INT2-8 Telegram-machine limit, SCL2-2..4.

## Round 3 (2026-11-08 03:36Z)

- Internal reviewers: all six (claude-opus-5-5). Gate: ran, degraded (`no-intelligence`), 0 flags. Cross-model: codex-cli:gpt-6-astra ok (SERIOUS ISSUES), body hash 02ed240d…
- Round-2 themes: resolved per security (4 of 5; /view partly), adversarial (2 full, 2 partly), scalability (all), integration (INT2-1..8 resolved or adopted; mechanisms checked against code), decision-completeness (no stop points left), lessons (LES2-2..7 resolved; LES2-1 partly).
- Design findings: security 3, adversarial 2, scalability 1, integration 4, decision-completeness 1, lessons 5, codex 2 → 8 themes:
  1. /view unlock refused by authMiddleware, no urlencoded parser, JSON errors, no PIN attempt limit; relayed views lose the sandbox header (SEC3-1, SEC3-3, LES3-1, LES3-2, INT3-3, INT3-4) → sig-carrying form post exempted by middleware, scoped parser, re-render, 5/15-min lockout, sandbox set by a path middleware on the answering machine.
  2. /dashboard/preview and installed console code are agent-writable and same-origin (SEC3-2) → boundary stated honestly; browser-signed messages marked `client: 'browser'` in the origin record and shown as such; ratchet classifies static mounts too.
  3. No revoke outbox; forwardRevoke unreachable from approveOutcome (ADV3-1, INT3-1) → activating machine writes the ledger revocation row itself.
  4. Activation effects not crash-recoverable; no "registry sweep" exists (codex, INT3-2, SCL3-1, LES3-6) → `effects` on the record, resumed from leaseTick (before the lease-holder early return) and at boot, bounded backoff.
  5. Key deleted on non-definite answers from another machine / unreadable ledger (ADV3-2, INT3-5, codex) → delete only on `revoked` or terminal answers from the key's own machine; `unknown` state; 401 names the machine.
  6. Hourly setup limit evidence wrong (LES3-4, DC3-1) → judgment-candidate `maxSetupsPerHour`, bounds the owner-DM flood; removed setups not counted.
  7. No Maturation plan (LES3-3) → added.
  8. Live-proof BLOCKED rows count as FAIL (LES3-5) → tunnel move on the two-node harness; Face ID as an exemption approved with the spec.
- Precision adopted: SEC3-4 (classification), SEC3-5 (replaces sig covers new key + host; refuse revoked/double-named), SEC3-6 / ADV3-4 (host computed first), ADV3-3 (poller liveness, handover, ≤8), ADV3-5..8, DC3-2..4 (clock message, requestId time, reason), SCL3-2..5, INT3-6..7 (Home in route(), dashboard path bypasses approvePending), LES3-7..8 (ship-live rationale, self-heal N/A), codex storage wording.

## Round 4 (2026-11-08 03:50Z)

- Internal reviewers: all six (claude-opus-5-5). Gate: ran, degraded (`no-intelligence`), 0 flags. Cross-model: codex-cli:gpt-6-astra ok (SERIOUS ISSUES), body hash e829ead1…
- Round-3 themes: scalability clean (0 design); lessons 0 design (6 resolved, 2 partly); security 3 resolved, 1 overstated, 1 partly; adversarial ADV3-1/2 resolved; integration 5 resolved, 1 partly; decision-completeness no stop points beyond two end states.
- Design findings: security 2, adversarial 1, scalability 0, integration 1, decision-completeness 2, lessons 0, codex 3 → 6 themes:
  1. /view unlock repair is a feature of its own: new PIN-guessing surface, needs relay protocol + durable escalating lockout (SEC4-1, SEC4-2, INT4-1) → scope cut: this spec only sandboxes /view (no scripts, no forms); unlock unchanged; filed fb-fa94058c-e42.
  2. Browser/phone distinction not durable (codex) → `client: 'browser'` inside the signed ledger activation row; older machines reject that row and read `unknown`, never phone; unsigned origin-record marker dropped (moots INT4-4).
  3. Crash window between ledger row and registry write (codex) → activation intent recorded on the pending record first; recovery covers every crash point.
  4. Pending setup end states: decline/expiry via successful GET (codex); stuck `notifying` (DC4-2) → handled; 30 s timeout.
  5. Effects abandoned after 24 attempts (DC4-1) → never dropped; hourly + every boot; decision row.
  6. Status precedence ledger vs registry (ADV4-1, INT4-3, ADV4-5) → precedence order; ledger revocation wins everywhere.
- Precision adopted: Maturation plan exact labels + ladder (LES4-1, INT4-2), Face ID via software presence key instead of an exemption (LES4-2), SEC4-3 (no scripts), SEC4-4 (wording), SEC4-6 (case), ADV4-2..4 (same-write effects, machineId from setup answer, effects on revoked records, existing revocation = done), DC4-4 (≤8 row, ninth tab), SCL4-1..4 (flag-guarded scan, switch-independent recovery, single status check), LES4-4 (wording).

## Round 5 (2026-11-08 04:00Z)

- Internal reviewers: all six (claude-opus-5-5). Gate: ran, degraded (`no-intelligence`), 0 flags. Cross-model: codex-cli:gpt-6-astra ok (SERIOUS ISSUES), body hash 67ac160a…
- Round-4 themes: scalability clean; decision-completeness clean (DC4-3, the /view lockout row, became moot with the scope cut); security clean (5/5 resolved); adversarial 5/5 verifiable resolved; integration 3 resolved, maturation ladder not; lessons LES4-2/4 resolved, LES4-3 moot, LES4-1 not (ladder value).
- Design findings: security 0, scalability 0, decision-completeness 0, adversarial 2, integration 3, lessons 3, codex 3 → 9 themes:
  1. `client` stripped by the replicated store's known-field list → rejected between new machines; no repair for upgraded peers (LES5-1, INT5-1) → `client` in KNOWN; activating machine re-publishes browser activation rows at boot.
  2. Boot/lease/TTL expiry runs before recovery and blocks activation (ADV5-1, INT5-2) → recovery before expireAllPending; expiry and pruning skip records with `activating`/`effects`; `activateBrowser` registry method.
  3. A `notifying` record approvable, then removed while active (ADV5-2) → only `awaiting` records are waiting devices; `removeIfStillSettingUp`.
  4. Maturation ladder value fails the gate (INT5-3, LES5-2) → `- **ladder:** mobilePairing.browser`; gate run returns ok.
  5. Unfinished sends retried under a new device id (codex) → bound to deviceId + machineId; never re-sent under another key.
  6. GET /mobile/device admission narrower than setup needs (codex) → pending, active, declined, expired.
  7. Pruning can erase pending effects (codex, DC5-3) → pruning skips records with effects.
  8. Sandboxed PIN page shows a dead form (LES5-3) → static notice, no form.
  9. iPhone-app generic mark untracked (LES5-4) → fb-c5049bee-69a; fleet graduation condition.
- Precision adopted: SEC5-1/INT5-4 (recordActivation reads client), SEC5-2 (no writes from URL), ADV5-3 (replaces only for activated keys), ADV5-4 (focused tab always polled), DC5-1 (fixed default 8), DC5-2 (leaseTick clears stuck notifying), INT5-5 (rollback limit stated), INT5-6/SCL5-1 (one ledger lookup), LES5-5 (regression row), codex summary contradiction.

## Round 6 (2026-11-08, final round at the Tier 2 cap)

- Internal reviewers: all six (claude-opus-5-5). Gate: ran, degraded (`no-intelligence`), 0 flags. Cross-model: codex-cli:gpt-6-astra ok (SERIOUS ISSUES).
- Round-5 themes: all nine resolved, except theme 1's re-publish half, which round 6 replaced (below).
- Design findings: security 1, adversarial 1, integration 1 (same as adversarial), lessons 1, scalability 0, decision-completeness 0, codex 3 → 6 themes:
  1. A Decline tap or third wrong code racing an approval (SEC6-1, **security-relevant**, low) → `setActivating` only on a pending, non-declined, `awaiting` record (or the dashboard path's own record); decline and wrong codes leave a record with `activating` alone; `activateBrowser` never activates a declined record. Synchronous registry writes, so the first writer wins.
  2. "Recovery at boot before `expireAllPending`" is not buildable: expiry runs in the service constructor before the ledger is attached (ADV6-1, INT6-1) → recovery runs at ledger attach, next to reconcile; `activating` with no ledger row → expired; no ledger → left and reported once (ADV6-2).
  3. Boot re-publish unnecessary and incomplete (LES6-1; codex: misses a peer upgrading while the activator runs and revoked browsers) → removed. Verified in code: an older peer's `JournalSyncApplier` stores the raw entry; after upgrade its boot union read (`loadOriginRecords` → `validateReplicatedEnvelope` with the new KNOWN list → `ingestReplicated`) accepts it, activation and revocation rows alike. INT6-4 and SEC6-2 moot.
  4. Hourly setup limit exceeded by concurrent setups across the async delivery (codex) → counted on record creation, check and create in one synchronous step; slot returned when the approval message was not delivered.
  5. Browser composer lacked the phone's credential-shape choice (codex) → same local prompt; browser copy of `detectOutboundCredential` patterns with a parity test.
- Precision adopted: LES6-2 (notice wording), INT6-3 (ladder id/risk), ADV6-3 (local attention + push fallback after 24 attempts; report above 20 records with effects), DC6-2 (decision row for the 30 s `notifying` removal), DC6-1 moot, SCL6-1/2 moot (re-publish removed).
- Cap outcome: round 6 still raised one security-relevant design finding, so per the skill no convergence tag is self-stamped. Fixes applied after round 6 and checked by one independent reviewer (below); decision passed to Echo under the standing grant.
- Independent check of the round-6 fixes (one fresh reviewer, claude-opus-5-5, read-only, against the code): all six fixes VERIFIED. Raised after the fixes, all now applied (spec hash 49c02a09):
  - DESIGN, not security: the 24-attempt fallback would push to owner phones every hour (the push dedupe key changes per call) → raised once, `fallbackRaisedAt`, later retries Telegram only.
  - PRECISION, low security: a record with `activating` still listed as waiting and falsely answered "declined" → excluded from waiting devices; second `setActivating` refused; id-based decline answers "already approved".
  - PRECISION, low security: one PIN entry could create two records concurrently → steps 4–8 in one synchronous step.
  - PRECISION: slot bookkeeping `{deviceId, at}`; every `removeIfStillSettingUp` returns the slot (contradiction removed); lease/null refusals use it; expired-with-activating only via downgrade (test added); recovery wording; replica retention stated; credential parity fixtures.
