# Side-effects review — Failure-Learning sources wiring + migration-parity assertion

## What changed

Two structural backstops shipped together, both targeting recurring bug classes
named in the 2026-05-29 pipeline post-mortem.

1. **Failure-Learning Loop: unimplemented-source warning + wiring-integrity test.**
   `monitoring.failureLearning.sources.regression` and
   `monitoring.failureLearning.sources.degradation` are config flags shipped
   without implementations: setting them on did absolutely nothing. The flag
   created a false sense of coverage — exactly the "specced but not wired"
   class that produced PR #530 (AttributionResolver Phase 2 specced, never
   wired, every burn alarm read 100% pre-attribution). A new boot-time
   `console.warn` names the unimplemented sources, says they are silent
   no-ops, and tells the operator to set them back off until impl ships.
   A new unit-tier test asserts the CiFailurePoller and RevertDetector are
   constructed iff their flags are on, and that the unimplemented-source
   warning fires on the right configurations and stays quiet on the right
   ones — so a future regression in the gating logic cannot silently
   disable the loop.

2. **Migration parity: a static assertion that fresh-init hook installs match
   auto-update hook installs.** Per the "Migration parity skip" class
   (telegram-reply.sh 403, autonomous-stop-hook broken path, the
   slack-channel-context.sh divergence we found mid-PR in #542). The test
   reads `installHooks()` (src/commands/init.ts) and `migrateHooks()`
   (src/core/PostUpdateMigrator.ts), extracts the set of hook files each
   writes, and asserts neither side has a file the other doesn't —
   except for a small documented allowlist of migrator-only deferred-install
   files. The allowlist's soft cap (10) trips a regression alarm if the
   gap widens.

## Why

The May 2026 fix-rate to main was ~19% (150 of 781 commits over 14 days). The
Failure-Learning Loop had captured exactly **one** event total — a manual
agent-diagnosed entry I posted on the morning of the post-mortem itself. The
loop's substrate (CiFailurePoller, RevertDetector, FailureLedger,
FailureAttributionEngine, /failures routes) was already shipped (slice 1 in
late April, slice 1b around #484), but every ingestion source was switched OFF
in `ConfigDefaults.ts`. So the meta-trace lever was unpulled.

I cannot flip a config default to a fleet-wide ON in a single PR — per-agent
opt-in is the model the spec sets. What I CAN ship is the missing structural
backstop: unimplemented sources must surface their gap visibly, and the
wiring-integrity test makes any future regression in the gating impossible to
miss. Plus the migration-parity test catches THE specific class that produced
the silent failure that initiated this whole conversation (a fresh-init agent
missing a hook the migrator installs, including telegram-topic-context.sh —
the exact file behind the 2026-05-29 incoherent-reply incident).

Echo's local config is being flipped to `sources.ci: true, sources.revert: true`
out-of-band as a dogfooding step; that's an agent-local change, not part of
this PR.

## Risk surface

- **Boot-time `console.warn` for unimplemented sources** — only fires when the
  agent has explicitly turned on `sources.regression: true` or
  `sources.degradation: ["..."]`. Default-off agents see nothing. The warning
  text is plain-English and tells the operator the explicit fix (set them
  back off). No state mutation; no API surface change.
- **Wiring-integrity test** — pure unit test, uses an in-process mock
  `SessionManager`. Doesn't construct an HTTP server, doesn't touch the
  network, doesn't read git. Risk: zero.
- **Migration-parity test** — static-analysis-only test. Parses
  `src/commands/init.ts` and `src/core/PostUpdateMigrator.ts` source files
  with a small regex (`fs.writeFileSync(path.join(hooksDir|instarHooksDir,
  '<filename>'), …)`) and compares the resulting sets. Doesn't run either
  function. Risk: zero.
- **Allowlist semantics** — the test treats the allowlist as deliberate
  accepted technical debt; growing it requires explicit code change + a
  documented rationale per entry. The soft cap (10) protects against silent
  drift.

## Bug surfaces eliminated

- `sources.regression: true` previously silently no-op'd → now warns loudly.
- `sources.degradation: ["x"]` previously silently no-op'd → now warns loudly.
- A future PR that adds a `migrateHooks()` write without an `installHooks()`
  counterpart → caught at commit time by the parity test.
- A future PR that adds an `installHooks()` write without a `migrateHooks()`
  counterpart → caught at commit time by the parity test (this is the more
  dangerous direction — the migrator overwrites on every cycle; a fresh-init
  file the migrator doesn't maintain drifts forever).
- A future regression that disables the CiFailurePoller construction when
  `sources.ci: true` → caught by wiring-integrity test.

## Migration footprint

- No fleet migration required. The boot-warning is purely an in-process side
  effect at AgentServer construction time; existing agents pick it up on the
  next process restart (which auto-update will trigger anyway).
- Default config defaults are unchanged. Per-agent opt-in remains the
  intended model for the sources.

## Testing

- Unit (wiring): `tests/unit/failure-learning-sources-wiring.test.ts` —
  9 tests. Constructed iff flag set (both directions), enabled:false
  inert across all source flags, unimplemented sources trigger one
  consolidated warning, implemented-only configs stay quiet.
- Unit (migration parity): `tests/unit/migration-parity-hooks.test.ts` —
  5 tests. Non-empty both sides, no install-only, no migrator-only outside
  allowlist, allowlist soft cap. Positive + destructive-negative verified
  (fake install-only write fails; fake migrator-only-without-allowlist
  fails).

## Test count

14 new tests across the unit tier. Existing related tests
(`CiFailurePoller.test.ts: 12`, `RevertDetector.test.ts: 9`,
`PostUpdateMigrator-time-injection.test.ts: 13`) remain green.

## Follow-ups (NOT in this PR — surfaced explicitly so the allowlist doesn't
hide them indefinitely):

- The `INSTALL_VS_MIGRATE_KNOWN_GAPS` allowlist enumerates 6 currently-accepted
  migrator-only hooks. Each entry is technical debt that should be closed by
  moving the file into `installHooks()` (or removing it from the migrator if
  it's no longer needed). Tracked in the allowlist comments so the soft cap
  surfaces drift.
- The `regression` and `degradation` source IMPLEMENTATIONS still need to
  ship. Those are separate features (the post-mortem's lever B —
  real-world-state fixture tests — closely related). This PR's warning
  closes the misleading-flag gap until then.
