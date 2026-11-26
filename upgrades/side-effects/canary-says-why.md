# Side-Effects Review — a failing sandbox check records its own output, and resuming has a lever

**Version / slug:** `canary-says-why`
**Date:** `2026-10-24`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent — three adversarial rounds (CONCERN → CONCERN → CONCUR); see below`
**Tier:** `1` — 4 source files, 2 test files, ~190 added lines; observability on an existing failure path, one cache-path redirect shared by two call sites, and a lever that clears a self-imposed wait. A revert fully undoes it; no persistent state beyond a longer string in an existing meta row, no user-facing surface.
**Effort:** 3 second-pass review rounds (round 1: 3 concerns; round 2: 4 more, including a mutation-proof that one of round 1's fixes did not hold; round 3: CONCUR with one small concern and three nits, all resolved). 0 spec rounds (Tier 1), 1 commit attempt. Three rounds is well above Tier-1 habit and was earned rather than ceremonial: rounds 2 and 3 each disproved an evidence claim this artifact was making, which is the point at which a review has stopped converging on style and is still finding substance.

## Summary of the change

Two defects in the feedback executor's pre-attempt sandbox rehearsal, both found by five
consecutive 24-hour latches on `base-unit-smoke` (2026-10-22 → 2026-10-24):

1. **The failure said nothing.** `runRunnerCanary`'s `mustSucceed` recorded `exit <n>` and discarded
   the command's captured stdout/stderr. The must-fail probes and the session-path probes already
   record their evidence (PR #2280); the runner-path must-succeed probes did not. The workspace that
   produced the output is deleted with the attempt, so the cause was unrecoverable after the fact —
   three hypotheses were tested by hand and all three refuted, and hand-patched logging on the
   running machine was wiped by each auto-update.
2. **Resuming had no lever.** `profileUnenforceable()` wrote a wait no route could clear, so a latch
   at the top of the ladder (1 h → 2 h → 4 h → 8 h → 24 h) stopped every fix attempt for a full day
   even once the cause was fixed and installed.

Changes:

- `confinementCanary.ts`: new exported `failureTail()` appends a bounded tail of stderr then stdout
  to a failed must-succeed probe's `detail`, redacting the canary's own nonce **before** slicing.
  `PROBE_TAIL_CHARS = 700` per stream.
- `executePolicy.ts`: new `confinedCacheEnv(tmpDir)` — ONE helper carrying every cache redirect
  (`TMPDIR`, `VITEST_CACHE_DIR`, `ESBUILD_CACHE_DIR`, and now `npm_config_cache` plus
  `update_notifier`/`fund`/`audit` off). Used by **both** the canary and `verifyFix`'s check runs.
- `executePolicy.ts`: `CANARY_PROBE_DETAIL_BUDGET = { maxBytes: 8192, maxChars: 2000 }` (was an
  inline 2048/300), consumed by `profileUnenforceable()` and ratcheted against `PROBE_TAIL_CHARS`.
- `executePolicy.ts`: `effectiveLatchUntil(latch)` — ONE reader for the legacy flat-day migration,
  so the availability check and the clear lever cannot disagree about whether a wait is in force.
- `executePolicy.ts`: `clampProbeDetail(text)` keeps a detail's **end** behind a `[…truncated]`
  marker when the scrubber's redaction expansion pushes it past the budget, instead of head-slicing
  the informative end away silently.
- `executePolicy.ts` + `FeedbackExecutorService.ts` + `routes.ts`: `retryCanaryNow(by)` and
  `POST /feedback-factory/execute/canary-retry` clear the latch's **wait only** — refused while a
  tick is in flight, rate-limited by a cooldown in its **own** meta row (`exec:canary_clear`), with
  the ladder position (`failures`) retained.

**Declared tier vs the risk floor.** The commit gate signals Tier 2 (risk floor raised by
"new capability: new route added") and records this Tier-1 declaration as `belowFloor: true`. Taken
deliberately: the route adds no authority — it clears a self-imposed wait on a gate that still runs
and still has to pass — and folding the lever into an unrelated existing route purely to avoid the
signal would be gaming the gate, not reducing risk. The override is on the record for the
cadence review, which is what that mechanism is for.

**Why one ship rather than two:** the local-verify queue runs one PR at a time at ~45 min each and
was 9 deep when this was written. Split across two PRs these would verify ~7 hours apart, and the
capture is useless on the operated host until the latch can be cleared — so the diagnostic would
have landed and then sat behind its own 24-hour wait. Both changes are in one tight area (the canary
and its latch) under one artifact, so "which fix caused which side effect" stays answerable.

## Decision-point inventory

- `runRunnerCanary` must-succeed verdict — **pass-through** — `ok = exitCode === 0 && !timedOut` is
  byte-identical, hoisted to a local. (The *detail* branch did change shape: it now keys off `ok`,
  so the `exitCode === 0 && timedOut` case no longer records the self-contradicting
  `{ ok: false, detail: 'ok' }`. Verdict-neutral, strictly more honest.)
- `verdictOf(probes)` → `profileUnenforceable()` latch — **pass-through** — identical inputs (probe
  names and `ok` flags); only the stored `detail` string is richer and its budget wider.
- Confined env for canary probes **and** for `verifyFix`'s base/lint/related runs — **modify** —
  four npm config vars added, via a shared helper so the two cannot diverge. Env grants no
  filesystem access; `buildSandboxRuntimeSettings` is untouched.
- Canary latch wait — **add (clear-only lever)** — a new route can set `until: 0`. It cannot set a
  wait, cannot skip the canary, and cannot reset the ladder.

---

## 1. Over-block

No new block/allow surface. The latch's trigger condition is unchanged, so nothing that previously
passed is now refused.

The env change can only move a probe from fail → pass, by removing a denied cache write that was
never part of what the probe asserts. It cannot move a probe pass → fail. That is the intended
correction and not a weakening: every must-fail probe in the same run must still be refused for the
verdict to be `ok`, and the smoke probe must still genuinely run the real unit test to exit 0.

**The hazard the reviewer caught, and how it is closed:** adding the redirect to the canary *alone*
would have made the rehearsal green on a condition `verifyFix` still hit — the canary rehearses the
very commands `verifyFix` runs, from the same `cfg.lintCommand` / `cfg.baseSmokeTests`. The result
would not have been an unsound pass (`classifyBaseFailure` returns `not-an-assertion-failure` on a
bare EPERM crash, so the attempt is refused) but burned attempts against `maxStartsPerDay` under a
misattributed `base-check:` / `gate:lint` reason instead of one honest latch. Both call sites now
take the same helper, so the divergence is structurally impossible rather than merely absent today.

The lever cannot over-block: it only removes a wait.

---

## 2. Under-block

Still missed, stated explicitly:

- **Must-succeed output is the one probe output the leak checks never scan.** `observed` is
  accumulated only in `mustFail`, so `effectChecks`' `secret-nonce-never-read` and
  `config-never-read` do not inspect must-succeed output. Pre-change that was harmless because the
  output was discarded; now it persists. Two layers cover the realistic cases — `failureTail`
  redacts the canary nonce (both the `canary-secret-` form and the bare value), and `scrubForStore`
  catches labelled/known-shape credentials such as `"authToken": <hex>` — but **a secret that is
  neither the nonce nor a known shape (a 6-digit dashboard PIN, say) is caught by neither.** The
  keychain probe and the decoy config are must-*fail* probes, so their output never reaches a tail.
- **Adversarial test fixtures can now be quoted into durable operator-read text.** The smoke lane
  runs instar's own unit tests, some of which carry literal prompt-injection fixtures. Credential
  shapes self-redact; injection-shaped payloads do not. This matters because of the AUP-wedge rule
  (keep literal adversarial payloads in files, reference them by path) once a session reads
  `/feedback-factory/execute/status` into its transcript. Bounded at ~2 KB per failed probe, and
  the smoke list is operator-configured, so the blast radius is small — but it is real.
- **Output beyond the 700-char-per-stream tail is dropped**, and in the `outputCapped` case the
  "tail" is the end of a *truncated prefix*: `runCapped` SIGKILLs at a 5 MB cap and keeps the first
  bytes, so a capped stream's real error at the end is already gone. `outputCapped` is not labelled
  in the detail, so a tail taken from capped output does not say so. Low likelihood at 5 MB.
- **A command that fails with no output at all** yields `exit 1 — no output`: honest, still
  uninformative. Recording the probe's command line is the next rung and is not in this change.
- **Nonce redaction also rewrites the nonce inside probe paths** (`.feedback-canary-hl-<nonce>` →
  `.feedback-canary-hl-[canary-nonce]`), slightly degrading the diagnosability this change is for.
  Accepted deliberately: safety over legibility, and the probe name already identifies the path.
- **The env redirect addresses npm's cache specifically, and is narrower than a sibling path
  needed.** `depsCache.ts`'s native rebuild redirects the whole of `HOME` because npm/node-gyp write
  outside the cache dir (`~/Library/Caches/node-gyp`, the gyp devdir). `confinedCacheEnv` leaves
  `HOME` pointing at the denied real home and redirects only `npm_config_cache`. That is enough for
  `npx vitest`, which resolves locally and fetches nothing — but it is a narrower mechanism than the
  one that path found insufficient, and the hypothesis is unconfirmed either way. If
  `base-unit-smoke` fails for an unrelated reason this does not fix it; it makes the next failure
  say so.
- **The shared helper covers the rehearsal pair, not the file.** `depsCache.ts` still builds its own
  env, by design (a different problem with a different answer). "They cannot drift" is true of the
  canary and `verifyFix`, which is where the hazard was.
- **The lever does not prove the sandbox is fixed.** Clearing a wait on a still-broken sandbox burns
  one attempt and re-latches one rung further along. The cooldown bounds the rate; it does not make
  a clear wise. It also cannot become an autonomous loop — every clear needs a caller.
- **A lease that moves between the route's owner check and the fenced write** throws out of a
  non-async handler and surfaces as a 500 rather than a 409. This is the pre-existing shape of every
  lever in this service (`revoke-acceptance` included), so it is not introduced here, but the route's
  response set is not exhaustive.
- **The clear's audit row records `by: 'api'` for every call**, so it cannot tell the operator from
  an agent session holding the Bearer token. Acceptable for a lever that grants nothing a passing
  canary would not, but it is the only provenance this surface keeps.
- **A credential-dense detail can still be truncated**, now from the front with a visible marker.
  The expansion only happens where a secret was redacted, so what is lost is mostly redaction noise
  — but a real error sitting behind a long run of redactions would go with it.

---

## 3. Level-of-abstraction fit

Right layer, for all three pieces.

The runner already captures stdout/stderr (`ConfinedRunner.run` returns them); the only defect was
that the canary dropped them between capture and storage. The fix records at the point of
observation and stores through the existing durable path (`profileUnenforceable` → `scrubForStore` →
`exec:profile_unenforceable` meta → `GET /feedback-factory/execute/status`). No new log file, no
parallel channel.

Bounding belongs in the canary and that is load-bearing, not stylistic: `scrubForStore` replaces an
over-size field *wholesale* with a withheld marker, so an unbounded tail handed to it would be
discarded entirely — reproducing the exact blindness being removed. The canary bounds; the store's
budget is widened to fit what the canary guarantees; a ratchet derives the real worst case from the
format itself (`exitCode: null` and ` (timed out)` co-occur, because the timeout path is the SIGKILL
path) and fails if raising the tail would overflow the budget. The scrubber can still expand a
redaction-heavy detail past the budget, which no length ratchet can bound — so that case is handled
in the code instead, by clamping from the end with a visible marker rather than silently dropping
the informative tail.

The cache redirect belongs in `executePolicy` beside `confinedEnv` because two call sites need the
identical set and the rehearsal's whole purpose is to be faithful to the real run.

The lever belongs on the service (it owns the latch meta and the availability cache) exposed by a
route, matching `release` / `revoke-acceptance`.

**Boundary against the spec's shared SelfHealGate.** `feedback-triage-and-execution.md` §219 assigns
re-probe LADDERS (the triage-authority self-heal: 30 min → 1 h → 4 h, bounded, audited) to a shared
`SelfHealGate` once that gate exists. This lever is deliberately NOT such a ladder: it has no timer,
no attempt budget and no autonomous trigger — every clear needs a caller. So it does not pre-empt
that gate or create a competing self-heal path. If the canary latch should ever re-probe ITSELF on a
ladder, that belongs in `SelfHealGate`, not here, and this lever stays the manual lever beside it.
The 24 h wait and its 1 h → 24 h ladder are implementation choices, not spec requirements — §185
specifies only "any wrong result → `profile-unenforceable`, one Attention item per episode" — so
making the wait clearable contradicts nothing approved.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The canary IS an authority (its verdict latches the executor), and this change deliberately does not
touch the verdict: `ok` is computed from the same two fields by the same expression, and the capture
runs after it and only when `ok` is already false. The env change alters an *input*, and does so by
removing an artefact of confinement that is not part of what the probe asserts — the sandbox
profile, which is what actually enforces the lock, is unchanged.

The lever adds no authority either. It removes a self-imposed wait; the gate it was protecting still
runs and still has to pass, so a clear grants nothing a passing rehearsal would not. Halting stays
automatic and free, which is the right asymmetry.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The new conditionals are "is this
stream empty", "take the last N characters", "is the latch in the future", and "was it cleared
within the cooldown" — string formatting and two deterministic time comparisons, with no competing
live signals to weigh. The cooldown is a safety brake on a repeatable action, deterministic by
design.

---

## 5. Interactions

- **Shadowing:** `failureTail` runs only inside `mustSucceed`'s failure branch, after the verdict.
  It cannot shadow the must-fail probes (separate helper), `effectChecks`, or `linkEffectChecks`,
  all of which run afterwards and are untouched.
- **Double-fire:** none. The detail is written once per failed probe and consumed once by
  `profileUnenforceable`. `exec:canary_last` stores probe names only and is unchanged.
- **Races:** `failureTail` is pure; `runCapped` spreads `command.env` rather than mutating it;
  `settings` derives from `ConfinementPaths` only, never from env — verified. The lever writes the
  latch meta through the same epoch-fenced `setMeta` every other writer uses, so a stale-epoch write
  is refused as it is everywhere else.
- **Feedback loops:** the stored detail is read by `GET /feedback-factory/execute/status` and the
  latch's attention item lists probe *names* only, so a captured tail cannot enlarge a user-facing
  alert. Neither feeds back into the canary.
- **Shared env (corrected from the first draft of this review):** the canary and `verifyFix` now
  share `confinedCacheEnv` deliberately. The first draft cited their separateness as reassurance;
  the reviewer showed the separateness *was* the hazard.
- **`confinedEnv` filtering:** the four npm names are not credential-shaped, so they survive its
  filter as intended.
- **Availability cache:** the lever sets `this.availability = null` like `revokeApproverAcceptance`,
  so the next status read recomputes rather than serving a stale refusal.
- **Ladder:** the lever retains `failures`, so a genuinely broken sandbox keeps climbing
  1 h → 24 h instead of being reset to the bottom by repeated clears.

---

## 6. External surfaces

- **Other agents / install base:** the feedback executor is dev-gated (`feedbackFactory.execute`,
  503 on the fleet) and runs on one operated host. No fleet-visible surface.
- **External systems:** none. No network, no GitHub, no Telegram path touched.
- **Persistent state:** `exec:profile_unenforceable`'s `failedDetail[].detail` gets longer (≤2000
  chars after scrub, previously ≤300) and gains `waitClearedAt` / `waitClearedBy` on a clear —
  deliberately NOT the pre-existing `clearedAt`, which the canary-pass path already writes to mean
  "the ladder was reset"; reusing one field for two events is what made the first version's cooldown
  unable to survive the failure cycle it rate-limits. One new row, `exec:canary_clear`, holds the
  cooldown. Same keys otherwise, additive; older rows stay readable, no migration.
- **New route:** `POST /feedback-factory/execute/canary-retry` — Bearer-authed, requires
  `X-Instar-Request: 1`, lease-guarded by `triageOwnerConflict`, 503 when the executor is
  unavailable, 409 with a named reason when a tick is in flight, there is nothing to clear, or the
  cooldown is live. Not exhaustive: a lease that moves mid-handler surfaces as a 500 (the
  pre-existing shape of every lever here).
- **Operator surface (Mobile-Complete):** this adds no operator-facing *decision*. The lever is an
  agent action on agent-owned infrastructure — the same class as `/execute/release` and
  `/execute/stop`, which are likewise agent-driven and documented for conversational use ("stop that
  item", "let it be tried again"). The operator-facing PIN-gated actions in this subsystem (the
  approver acceptance, the triage authority) are untouched and keep their dashboard forms. Nothing
  here requires a human to type a command.
- **Timing/runtime:** `npm_config_cache` points into each run's own temp directory, created per
  attempt and removed with it, so npm's cache is cold each run. `npx` resolves `vitest` from the
  workspace's linked `node_modules`, not the registry (the sandbox has no network), so a cold cache
  adds no fetch; cost stays bounded by `CONFINED_COMMAND_TIMEOUT_MS`.
- **Scrub cost:** `maxBytes` 8192 against a 1 MB default — well inside the scrubber's timing budget.

---

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard renderer, approval page, or grant/secret form is
touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The confinement canary rehearses *this machine's* sandbox: it probes
this machine's filesystem, its login keychain, its sandbox runtime version, and its own loopback
listener. A verdict from one machine says nothing about another's, which is why the latch meta is
already per-machine, and why the executor runs only on the operated host
(`feedbackFactory.operatedHostMachineId`).

The new route follows the same posture and is explicitly fenced: `triageOwnerConflict` makes a
non-owning machine answer with a conflict naming the owner rather than clearing a latch it does not
own, and `setMeta` is epoch-fenced on top.

- **User-facing notices:** the attention item on latch is pre-existing and unchanged; no new notice
  is emitted, so no one-voice gating question arises.
- **Durable state on topic transfer:** the latch is machine state, not topic state — it does not
  travel with a conversation and cannot strand on transfer.
- **Generated URLs:** none generated.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit, ship as the next patch. Pure code change.
- **Data migration:** none. A reverted build writes shorter details again and ignores
  `clearedAt` / `clearedBy`, which are additive fields on a row it already tolerates.
- **Agent state repair:** none. No agent needs notifying or resetting. A latch cleared before the
  revert stays cleared, which is the safe direction (the canary simply runs again).
- **User visibility:** none. Reverting restores the previous uninformative detail and removes the
  lever; the 24-hour wait becomes unclearable again, which is the pre-change behaviour.

---

## Conclusion

Two adversarial review rounds changed this materially, and the second round was the one that
mattered most, because it mutation-tested round one's own fixes and showed one of them did not hold.

Round one caught the real hazard: the npm redirect was going into the canary *only*, which would
have made the rehearsal pass on a condition the real gate still hit — trading one honest latch for a
run of attempts failing under the wrong attribution. That is now a single helper used by both.

Round two then proved, by mutation, that round one's "end-to-end test" never touched the code it was
meant to guard: narrowing the stored slice back to 300 left every test green. It also showed the
ratchet's hand-counted overhead was three characters short of the real worst case (`exitCode: null`
on the SIGKILL that the timeout path takes, so `null` and ` (timed out)` co-occur), that a length
ratchet cannot bound the scrubber's redaction *expansion* at all, and that the lever's cooldown was
keyed on a field the failing canary rewrites — so the brake released in precisely the case that
costs a whole canary run and bound only when nothing had run.

Round three then found that the clamp's *wiring* was unguarded — removing it from the store path
left every test green — and that one of this artifact's own mutation claims did not support the fix
it was cited for. Both are corrected. Every guard that can be mutation-verified now is; the two that
cannot (a degenerate budget behind an `as const`, and a write ORDER where both writes succeed) are
labelled as reasoned rather than proven.

The honest limit is unchanged: the npm cache redirect is the leading *suspect* for the five
`base-unit-smoke` latches, not a confirmed cause — and round two sharpened why to stay humble about
it, since a sibling path hit the same class of problem and needed a full `HOME` redirect rather than
a cache-path one. Three hypotheses were tested by hand over three days and all three were refuted,
which is exactly why the capture — not the guess — is the load-bearing half. If the suspect is
wrong, the next failure names the real cause in its own words instead of costing another day, and
the lever means that next failure can happen within minutes of the fix installing rather than at the
end of a 24-hour wait.

Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent, two rounds. Round one read the diff, this artifact,
`docs/signal-vs-authority.md`, all of `runRunnerCanary`/`verdictOf`/`effectChecks`,
`profileUnenforceable()` and the canary call site,
`confinedEnv`/`buildSandboxRuntimeSettings`/`SandboxRuntimeRunner.run`, `scrubForStore`, and every
consumer of `failedDetail`. Round two re-read the resolutions and mutation-tested them.

**Round 1 — CONCERN (3 concerns, 5 nits).**

- **C1 — the redirect was added to the canary but not to the runs it rehearses.** **Resolved:**
  extracted `confinedCacheEnv()`, used at both call sites, asserted by test.
- **C2 — nothing coupled `PROBE_TAIL_CHARS` to the downstream budget.** **Resolved in round 1,
  found insufficient in round 2** (below).
- **C3 — Under-block omission: must-succeed output is the one probe output `effectChecks` never
  scans**, and a secret that is neither the nonce nor a known shape is caught by neither layer.
  **Resolved:** named explicitly, with the adversarial-fixture hazard.
- **NITs:** the `detail` predicate's shape change (recorded in the inventory); redaction ran after
  slicing (**resolved** — it now runs before, and round two confirmed the slice cannot defeat it);
  the budget widening had no test (**resolved** in round 2); `outputCapped` tail semantics
  (**named**); adversarial fixtures reaching durable text (**named**).

**Round 2 — CONCERN (3 concerns, 4 nits), all resolved.**

- **C4 — round 1's "end-to-end test" did not exercise the latch write.** It wrote the meta row
  directly and read it back, so `profileUnenforceable`'s scrub+clamp was never on the path; the
  reviewer mutation-tested it and narrowing the slice to 300 left 130/130 green. **Resolved:** the
  test now scripts the confined runner so `npx vitest` fails with long output, drives a real
  `h.exec.tick()`, and asserts the stored detail. Mutation-verified: the 300-char slice now fails it.
- **C5 — the ratchet's overhead was under-counted by 3**, permitting `PROBE_TAIL_CHARS` up to 980
  where the real detail is 2003 against a 2000 budget. **Resolved:** the worst case is now DERIVED
  from the real format rather than hand-counted. Mutation-verified at 1000.
- **C6 — the ratchet bounds a pre-scrub length against a post-scrub slice**, and `scrubForStore`
  expands where it redacts (a measured 1523-char tail became 2667). No length ratchet can bound
  that. **Resolved in code rather than in a test:** `clampProbeDetail` keeps the detail's end behind
  a `[…truncated]` marker. Mutation-verified (head-slicing fails the test).
- **C7 — the lever's cooldown could not bind across a re-latch.** `profileUnenforceable` writes a
  fresh literal with no `clearedAt`, so the brake released exactly when a clear costs a full canary
  run; and `clearedAt` is pre-existing on `main` with a different meaning (the canary-pass ladder
  reset), so one field was carrying two events. **Resolved:** the cooldown moved to its own
  `exec:canary_clear` row; the lever writes `waitClearedAt`/`waitClearedBy`. Mutation-verified.
- **C8 (minor) — no in-flight guard**, so a clear during a failing canary was silently overwritten
  while the caller got `200 {cleared: true}`. **Resolved:** refuses with the service's existing
  `tick-in-flight` idiom. Mutation-verified.
- **NITs:** `depsCache`'s own env and its wider `HOME` redirect (**named in Under-block** — and it
  is why the npm hypothesis stays a suspect); the 500-on-lease-move response (**named**); a legacy
  latch already expired under the migration answering `cleared: true` (**resolved** — one
  `effectiveLatchUntil` reader, asserted); `by: 'api'` provenance (**named**).

Round 2 confirmed resolutions 1 and 3 hold as claimed, and re-verified that the signal-vs-authority
check is unaffected: no block/allow surface is added, the authority receives identical inputs, and
the lever only removes a wait the gate it protects will re-impose if the sandbox is still broken.

**Round 3 — CONCUR (1 small concern, 3 nits), all resolved.**

Round 3 re-verified every round-2 closure with its own arithmetic and mutation tests: `exit null
(timed out)` is genuinely the worst prefix (`runCapped` resolves `exitCode` from `close`, 0–255 or
`null` on SIGKILL/spawn error, and the timeout path IS the SIGKILL path); `exec:canary_clear` is
written and read in exactly one place each and the canary-pass branch leaves it intact; the
in-flight guard's position before the latch read is the conservative order (during a tick a latch
may be about to be written, so `not-latched` would be the misleading answer); and
`effectiveLatchUntil` is a faithful extraction with every gating reader migrated.

- **C9 (small) — the clamp's WIRING was unguarded.** Round 3 mutation-tested replacing
  `clampProbeDetail(scrubbed.text)` with `scrubbed.text` and the service test stayed 83/83 green:
  its fixture's detail was ~1428 chars post-scrub with no credential shapes, so the clamp was a
  no-op there, and the units test called the helper directly. C6's actual failure mode — scrub
  expansion past the budget — was exercised by no test end to end. **Resolved:** a credential-dense
  fixture (`pwd:abcdefghijkl` repeated) now drives a real tick whose post-scrub detail overflows,
  asserting the stored detail is exactly `maxChars`, carries the marker, and still ends with the
  error. Mutation-verified: unwiring the clamp now fails it.
- **C10 (nit, latent) — `clampProbeDetail` could return MORE than the budget.** At
  `maxChars <= marker.length` the subtraction goes negative and `slice(-negative)` becomes a HEAD
  slice (round 3 measured 9013 chars returned for a 9000-char input at `maxChars: 13`). Unreachable
  at the pinned constant, but the helper is exported and reads as a general clamp. **Resolved** with
  a `Math.max(0, …)` guard and a comment naming why.
- **C11 (nit) — the lever wrote the cooldown BEFORE the latch**, so a failure on the second fenced
  write would consume the brake without clearing the wait, spending the caller's only move for
  nothing. **Resolved:** latch first, cooldown second.
- **C12 (nit) — surrogate pairs.** The clamp slices by code unit, so a kept region can begin with a
  lone surrogate. Length stays exactly at the budget and `JSON.stringify`/`parse` round-trips it
  (it renders as U+FFFD). **Named, not fixed** — cosmetic, and grapheme-safe slicing is a bigger
  change than the defect warrants.
- Round 3 also corrected an **evidence claim in this artifact**: mutation (4) at `PROBE_TAIL_CHARS`
  1000 was non-discriminating. Re-run at 980 and recorded above.

---

## Evidence pointers

- Live state that motivated this: `GET /feedback-factory/execute/status` on the operated host —
  `profileUnenforceable: { episode: 1, failures: 5, failed: ["base-unit-smoke"], failedDetail:
  [{ probe: "base-unit-smoke", detail: "exit 1" }] }`, `until` 24 h out, five consecutive attempts
  `stopped / profile-unenforceable`.
- New tests fail for the right reason on unpatched source (verified by reverting `src/`):
  `expected 'exit 1' to contain 'EPERM'`, `failureTail is not a function`, and
  `expected undefined to be '<tmpDir>/npm'`.
- `tests/unit/feedback-factory/execute-units.test.ts` + `execute-service.test.ts` — 131/131;
  executor unit group (5 files) green; `npm run lint` clean; `tsc --noEmit` clean.
- Mutation-verified guards (each previously-passing suite now fails): narrowing the stored slice to
  300; keying the cooldown inside the latch row; removing the in-flight refusal; unwiring
  `clampProbeDetail` from the store path; `clampProbeDetail` head-slicing instead of keeping the
  end; and `PROBE_TAIL_CHARS` raised to **980**.
- **980, not 1000** — corrected after round 3. 1000 fails the old hand-counted ratchet too
  (2040 > 2000), so it proved only that *a* ratchet exists, not that the three-character under-count
  was fixed. 980 is the discriminating value: it passes the old arithmetic (2000 ≤ 2000) and fails
  the derived one (2003 > 2000). The earlier "mutation-verified at 1000" line did not support the
  fix it was cited for.
- **Not mutation-verified, stated as such:** the degenerate-budget guard in `clampProbeDetail`
  (`maxChars <= marker.length`). `CANARY_PROBE_DETAIL_BUDGET` is `as const`, so no test can supply
  the input that would exercise it; it is a defensive guard on an exported helper, documented at the
  site. The lever's write ORDER (latch before cooldown) is likewise not observable from a test where
  both writes succeed — it is reasoned, not proven.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defects are in instar's own TypeScript (a
discarded capture; a wait with no clear path), not in an LLM prompt, hook, config, skill, or
standards text. No self-triggered controller is added or modified: the canary, its latch and its
retry ladder already exist and are unchanged here, and the new lever fires only on an authenticated
request — never on its own.
