# Post-transfer closeout lease carve-out + first-party bootstrap provenance (matrix F8 + F7)

<!-- bump: patch -->

## What Changed

Two fixes from the 2026-07-02 live test-as-self matrix (roadmap 0.6):

**F8 — the post-transfer closeout can finally land.** After a cross-machine topic
transfer, the OLD owner's closeout sweeper was structurally vetoed
`skipped:'not-lease-holder'` on every attempt — the machine a topic moves AWAY
from is by definition usually NOT the serving-lease holder, so the reap
authority's lease gate denied the exact teardown the transfer requires, the P19
breaker gave up loudly after 5 attempts, and the leftover session survived
(duplicate-work risk). `terminateSession` now accepts a narrow
`bypassLeaseForTopicMovedCloseout` opt that lifts ONLY the lease-holder gate;
the SessionReaper sets it exclusively inside the topic-moved closeout machinery
(reachable only after the ownership registry + dwell — and on the gated path,
remote liveness — have confirmed another machine owns the topic). Protected
sessions, the CAS/in-flight guard, and EVERY KEEP-guard still apply unchanged;
the flag is an in-process parameter no HTTP surface or content can mint; the
loud give-up remains as the honesty fallback for genuine KEEP-guard vetoes.

**F7 — instar no longer flags its own session bootstrap as a prompt injection.**
The session-boot bootstrap turn ("Read bootstrap file… Telegram Relay
(MANDATORY)…") is composed by instar itself but arrived at the InputGuard as
ordinary untagged text, so Layer 2 flagged instar's own boot template as a
suspected injection and a cautious fresh session skipped its bootstrap
processing (never read its context, never learned the relay command).
`injectMessage` now accepts an in-process `firstParty: { source }` provenance
opt, set at the three session-bootstrap injection lanes. The guard honors
provenance recorded at injection time — never a marker in the text — so a
content-only forged "first-party" claim (or a byte-identical copy of the
bootstrap template arriving as content) still traverses the full guard cascade
and is still flagged; there is nothing to string-match and therefore nothing to
forge. Every first-party injection is audited to the security log as
`first-party-injection`. All other injection lanes keep the exact prior guard
behavior.

## What to Tell Your User

<!-- audience: user, maturity: stable -->
- **Moving a conversation between machines now cleans up after itself**: when
  you move a conversation to another machine, the machine it left now reliably
  closes its leftover copy instead of silently keeping a duplicate around that
  could double-handle your messages. All the usual protections still apply — a
  session that is protected or genuinely mid-work is never closed.
- **Fresh sessions start on the right foot**: previously a brand-new session
  could mistake its own startup instructions for a suspicious injected message
  and skip them — which could make it miss context or fail to reply on the
  right channel. Startup instructions are now recognized as coming from me,
  while real outside messages get exactly the same scrutiny as before.

## Summary of New Capabilities

None — two correctness fixes to existing machinery (the reap authority's lease
gate and the input guard's provenance handling). No new routes, config keys, or
stores.

## Evidence

- F8: live matrix 2026-07-02 — post-transfer closeout audit showed
  `skipped:'not-lease-holder'` ×5 followed by the closeout breaker giving up,
  with the leftover session surviving on the old owner. Regression-shape test
  (`session-reaper-topic-moved.test.ts`: a lease-vetoing authority closes the
  leftover on the FIRST attempt once the bypass is honored — no veto streak, no
  breaker, no escalation) plus both-sides authority tests in
  `session-manager-terminate.test.ts` and the integration wiring suite.
- F7: live matrix 2026-07-02 — security log showed the boot template flagged by
  the InputGuard and the session skipping bootstrap processing. Both-sides
  boundary tests in `session-manager-first-party-inject.test.ts` (own bootstrap
  clean + audited; forged content claim and byte-identical template copy still
  flagged).
