# Side-Effects Review — F8 closeout lease carve-out + F7 first-party bootstrap provenance

**Source:** roadmap item 0.6 — findings F8 + F7 of the 2026-07-02 live test-as-self matrix.
**Tier:** 1 (two narrow, audited fixes to existing machinery; no new routes, no new config, no new stores).
**Files:** src/core/SessionManager.ts, src/monitoring/SessionReaper.ts, src/commands/server.ts,
tests/unit/session-manager-terminate.test.ts, tests/unit/session-reaper-topic-moved.test.ts,
tests/unit/session-reaper-closeout-liveness.test.ts, tests/unit/session-reaper-wiring.test.ts,
tests/unit/session-manager-first-party-inject.test.ts (new),
tests/integration/session-lifecycle-reap-wiring.test.ts

## What changed

1. **F8 — `terminateSession` gains `bypassLeaseForTopicMovedCloseout`** (SessionManager.ts): a
   narrow opt that lifts ONLY the lease-holder gate inside the `origin === 'autonomous'`
   authority cascade. Protected, CAS/in-flight, and EVERY KEEP-guard are unchanged and still
   run. The SessionReaper's `attemptCloseoutTerminate` (the shared topic-moved closeout
   machinery — the ONLY `deps.terminate` callsite on the closeout path) now sets the flag on
   every closeout terminate; the server.ts terminate-dep hop threads it through (dead-dep trap
   guarded by a wiring test).
2. **F7 — `injectMessage` gains `opts.firstParty: { source }`** (SessionManager.ts): in-process
   provenance for instar's OWN injections. When set, the InputGuard cascade (Layer 1
   provenance / Layer 1.5 patterns / Layer 2 LLM coherence) is skipped, the injection is
   audited to the security log as `first-party-injection`, and the text goes straight to
   `rawInject` (which still strips embedded bracketed-paste markers — the S2 sanitizer is
   downstream of the bypass, so a first-party injection cannot forge paste boundaries either).
   The three session-bootstrap lanes (existing-session reuse, ready-and-inject, still-alive
   fallback) set `firstParty: { source: 'session-bootstrap' }`.

## Blast radius — the reap-authority carve-out (the load-bearing review)

**What can now be reaped that couldn't before:** exactly one class of session — a LOCAL
session on a NON-lease-holding machine, terminated AUTONOMOUSLY, whose terminate call carries
`bypassLeaseForTopicMovedCloseout: true`. Before the fix such a terminate was unconditionally
`skipped:'not-lease-holder'`. Nothing else changed: on the lease-holding machine the flag is a
no-op (proven by test), and a flag-less standby terminate keeps today's veto byte-for-byte
(proven by test).

**Why the scope-guard prevents abuse — four independent layers:**

1. **In-process-only minting.** The flag is a function parameter on `terminateSession`. No
   HTTP surface reaches it: the operator kill route (`routes.ts`) hardcodes its opts object
   and never spreads request input into it; the remote-close relay stamps `origin:'operator'`
   (a different cascade entirely — operator kills always bypassed the lease gate, unchanged).
   Message content, config values, and peer traffic cannot mint the flag by construction.
2. **Single mint site, verified non-ownership upstream.** In the whole tree the flag is set
   `true` only inside `SessionReaper.attemptCloseoutTerminate` (pinned by a source-scope
   test), which is reachable ONLY from the two topic-moved closeout paths — both gated on
   `topicOwnerElsewhere` (the pool ownership registry names ANOTHER machine as the topic's
   owner) plus the multi-tick dwell, and on the gated path additionally on remote-owner
   liveness confirmation. "Provably no longer owns" is enforced before the flag exists.
3. **Only the lease gate lifts.** The carve-out is an `&&` clause on the lease check alone.
   Protected sessions (checked BEFORE the lease gate) still refuse — proven by test. Every
   KEEP-guard (recent-user-message, active-process, active-subagent, relay-lease, open
   commitments…) still runs and still vetoes — proven by tests on recent-user-message,
   active-subagent, and relay-lease. The Part E recent-message bypass is UNCHANGED and still
   only minted on the liveness-confirmed freshest-interaction path (proven by test: lease
   bypass carried while Part E is correctly withheld).
4. **The honesty layer is preserved.** The P19 veto breaker (5 attempts → loud give-up +
   attention escalation) is untouched. A closeout now vetoed by a genuine KEEP-guard still
   counts vetoes and still gives up loudly. The fix removes only the structural
   always-deny; it does not remove any honest terminal state.

**Worst-case abuse analysis:** a compromised or buggy in-process caller could pass the flag on
a non-closeout terminate. What it buys them: skipping ONE gate (lease) that `origin:'operator'`
already skips — while protected + all KEEP-guards still apply. The flag grants strictly LESS
authority than the pre-existing operator origin available to the same in-process callers, so it
introduces no new privilege class.

## Blast radius — the first-party injection bypass (F7)

- **What skips the guard:** only text injected through the three session-bootstrap lanes —
  text instar itself composed in-process seconds earlier. The Slack inbound lane
  (server.ts) carries live USER content inside its wrapper and is deliberately NOT tagged;
  TriageOrchestrator's inject dep maps to `sendInput` (never entered the guard); every other
  `injectMessage` caller is untouched and keeps the exact pre-fix cascade.
- **Unforgeability bar (per the audit):** the guard checks provenance recorded at injection
  time — an in-process parameter — not any string in the text. A content-only forged
  "first-party" claim and a byte-identical copy of the bootstrap template are BOTH proven by
  test to still traverse the full guard cascade and get flagged. There is no marker to
  string-match, hence nothing to forge.
- **Auditability:** every first-party injection writes a `first-party-injection` event
  (session, source label, 100-char preview) to `state/security.jsonl` — same log the guard's
  own flags land in, so the bypass is visible in exactly the place a security review reads.
- **Residual risk:** a future developer tags a lane that carries user content. Mitigation:
  the opt's doc comment states the rule (only injector code that AUTHORED the text may set
  it), and the wiring test pins the current tag sites (3, exactly) so any new tag site is a
  visible, reviewed diff.

## Risk + mitigation

- **Risk (F8):** a stale ownership signal closes a session the machine still owns.
  **Mitigation:** unchanged from the existing closeout design — the flag does not touch the
  ownership/dwell/liveness gates; it only changes what happens AFTER they have all passed.
  A wrongly-closed session is additionally covered by the existing reap-notify + resume-queue
  machinery (the topic gets told; mid-work sessions queue for revival).
- **Risk (F8):** double-kill race with the new owner. **Mitigation:** the CAS + in-flight
  guard on `terminateSession` is upstream of the carve-out and unchanged; and the session
  being killed is local-only — the new owner's session is on another machine, unreachable by
  this authority by construction.
- **Risk (F7):** the bootstrap bypass hides a real injection that rode INTO the bootstrap
  composition (e.g. hostile thread history quoted into the context file). **Mitigation:** the
  guard never reviewed the bootstrap-FILE content anyway (it reviews the injected turn, which
  is the short "[IMPORTANT: Read <path>…]" wrapper); the flagged-then-skipped failure mode it
  caused was strictly worse (the session skipped the relay instructions and went dark). The
  content-side defenses (quoting, `<replicated-untrusted-data>` envelopes, coherence gates)
  are unchanged.

## Migration parity

None required. No config keys, no hook templates, no CLAUDE.md template sections, no skills
changed. Both fixes are behavior inside existing in-process machinery and activate on the
next server restart after update, everywhere, with no flags — they fix guards that were
misfiring against instar's own operations; there is no "on" to gate.

## Rollback

Revert the commit. Both changes are additive opts on existing methods; removing them restores
the prior behavior exactly (F8: closeout vetoed on standby machines again; F7: bootstrap
flagged again). No state migration in either direction.

## Tests

- `tests/unit/session-manager-terminate.test.ts` (+6) — both sides of the F8 authority
  boundary: no-flag standby veto preserved; flagged closeout lands; protected still refuses;
  recent-user-message + active-subagent KEEP-guards still veto; awake-machine no-op.
- `tests/unit/session-reaper-topic-moved.test.ts` (+2) — the closeout terminate carries the
  flag (legacy path, with Part E + workEvidence semantics pinned unchanged); regression shape
  of the audit (lease-vetoing authority → first attempt lands, no breaker, no escalation).
- `tests/unit/session-reaper-closeout-liveness.test.ts` (+2) — gated path carries the flag;
  lease bypass carried even when Part E is correctly withheld.
- `tests/unit/session-reaper-wiring.test.ts` (+2) — server.ts dead-dep thread-through; the
  flag is minted ONLY inside `attemptCloseoutTerminate` (source-scope pin).
- `tests/integration/session-lifecycle-reap-wiring.test.ts` (+4) — F8 through the real
  wiring: closeout lands + reap-log honest reason; protected + relay-lease unweakened;
  no-flag veto preserved.
- `tests/unit/session-manager-first-party-inject.test.ts` (new, 4) — both sides of the F7
  boundary: own bootstrap passes unflagged (no layer runs, audited); content-only forged
  claim still flagged by Layer 1.5; byte-identical template copy still flagged by Layer 2;
  wiring pin on the three tag sites.
- `npx tsc --noEmit` clean; full unit suite green (Zero-Failure Standard) — see PR.

## Agent awareness

No CLAUDE.md template change: neither fix adds a capability an agent could invoke — both
repair internal machinery (the closeout sweeper now succeeds; the bootstrap is no longer
self-flagged). The existing "Reap-Log" and "Sender-Rejection"-style explain-surfaces already
cover "why did a session close after a move?" (the reap-log records the honest topic-moved
reason, unchanged).
