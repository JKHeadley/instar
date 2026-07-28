# Side-Effects Review — WS1.2 closeout P19 breaker + WS1.4 autonomous-run transfer guard

**Spec:** docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md §WS1.2 (closeout coupling + P19
foundation patch) + §WS1.4 (autonomous runs survive or veto topic moves)
**Build order position:** step 5's first slice. This change ships the two pieces that
are complete WITHOUT the drain mesh verb; the drain verb + barrier + terminal
semantics are the next item in this same workstream's build order (spec §WS1.2 lines
141–172) and extend — never rework — what ships here.

What ships:

1. **Closeout P19 breaker (SessionReaper):** the post-transfer closeout's veto-retry
   loop was unbounded — the 2026-06-12 incident was this exact loop attacking a
   working session every 2 minutes for hours. Now: after
   `topicMovedVetoBreakerAttempts` (default 5) CONSECUTIVE vetoed terminate attempts
   on the same session, retries STOP for the episode, one `closeout-breaker-open`
   audit row lands in sentinel-events.jsonl, and ONE deduped attention item surfaces
   ("topic moved to X but the old session won't close — held by Y"). The session is
   NOT stranded: the idle pipeline still evaluates it every tick and reaps it when
   its work actually finishes. Episode resets on success / topic-home /
   pin-conflict hold / session end.
2. **WS1.4 transfer-time veto (planTransferByNickname):** a LIVE local autonomous run
   on the topic → `confirm-required` (`detail: 'autonomous-run-in-flight'`),
   evaluated FIRST among the consent gates (spec precedence: the veto fires at
   transfer-request time, before any move mechanics). Wired into BOTH callers:
   POST /pool/transfer (confirm:true consents) and the NL "move this to <nick>" arm
   (prompts conversationally; the confirmed move arrives via the API).
3. **WS1.4 confirmed move → turn-boundary suspend (suspendAutonomousTopicForMove):**
   distinct from stop in exactly one way — the state file SURVIVES to ride the
   working-set carrier. `active: false` releases the stop hook at the run's next
   turn boundary; `moved_to` + `move_suspended_at` markers are the honest
   breadcrumb; the rewrite is ATOMIC (same-dir temp + fsync + rename) so the carrier
   can never ship a half-rewritten file; the journal `stopped` emit is what re-fires
   the receiving machine's working-set pull (WorkingSetManifest §3.4). Stated
   outright: NOTHING auto-resumes the run on the receiving machine — the carried
   file lands `active: false` with its markers, and resuming is a deliberate act
   (the operator's or a future workstream's). The spec's receiving-side schema
   gate applies when auto-resume exists; transport integrity (hash-verified
   assembly, torn-chunk refusal, never-clobber) is already enforced by the
   carrier today.

**Second-pass fixes folded in (2026-06-13, before merge):** the independent review
below caught two real defects in the WS1.4 half as first built — (1) a stacked-gate
consent collapse: `confirm:true` after the autonomous-run prompt would silently
consent to an offline target the user was never shown (the veto's higher precedence
suppressed the offline prompt). Fixed at the planner: ALL live consent conditions
now stack into ONE prompt with a '+'-joined `detail`, the route no longer suppresses
the gate on confirm (the full chain re-evaluates), and the 409 echoes `detail`.
(2) a silent false-success: the suspend's `active: true` flip regex was stricter
than the reader's quote-tolerant parse, so a quoted-active file would be reported
`suspended: true` while the run stayed live. Fixed: reader-aligned tolerant flip +
a post-flip verification gate that returns `suspended: false` (and emits nothing)
when the flip did not land; an inactive file with no move markers is an honest
no-op. Both fixes carry dedicated tests.

## 1. Over-block
The veto requires confirmation for EVERY move off a topic with a live run — including
a move the operator urgently wants. Bounded: one extra round-trip (`confirm:true`),
and the prompt carries goal + remaining time so the consent is informed
(context-before-consent, P8). The breaker stops closeout retries while a session
still SHOULD close — bounded by the idle pipeline still owning the session (it reaps
on actual completion) and by the attention item handing the operator the manual
lever. The idempotency no-op stays AHEAD of the veto, so "already there" never asks.

## 2. Under-block
The veto and the suspend read THIS machine's run registry (the state-file directory)
— a run living on a REMOTE owner (holder ≠ owner under the active-active pool) is
not seen, because the holder can neither see nor suspend a remote machine's run
without a drain signal; that is precisely the WS1.2 drain mesh verb's job (next item
in this workstream, spec §WS1.2 "drain authorization"), and today's production
topology (one-awake-machine; the run lives where the transfer executes) is fully
covered. The breaker counts only REAL vetoed terminate calls — budget-exhausted
ticks don't increment, so a busy reap hour cannot open the breaker spuriously.

## 3. Level-of-abstraction fit
The breaker lives inside the loop it bounds (P19's "in-component" rule). The veto is
a planner consent gate exactly beside the two existing ones (offline / mid-reply) —
no parallel mechanism. The suspend is a sibling of stopAutonomousTopic in the run
registry's own module, not route-inline logic. The carrier integrity story reuses
the EXISTING working-set machinery (manifest sha256, served-bytes assembly hash,
fstat tear detection, never-clobber landing, liveSource re-fire on `stopped`) —
nothing re-implemented.

## 4. Signal vs authority compliance
The breaker REMOVES authority (stops retrying a kill) on a deterministic counter and
escalates to the operator — the safe direction. The veto converts an implicit move
into explicit operator consent; it never blocks (confirm proceeds). The suspend acts
only on the operator's confirmed instruction, and the run's own stop hook remains
the enforcement authority (`active: false` is the hook's existing contract, not a
new kill path). No message content is inspected anywhere.

## 5. Interactions
- Breaker × pin-conflict hold (WS1.3): the hold withdraws the closeout intent and
  CLEARS the veto counter — a post-reconcile genuine move starts a fresh episode.
- Breaker × idle pipeline: a breaker-open session falls through to the idle
  evaluation the same tick (verified: only a successful terminate `continue`s).
- Breaker × attention queue: keyed `closeout-breaker:<session>` — the store dedupes
  on id (P17), which makes the dedupe per SESSION LIFETIME, not per episode: a
  second breaker episode for the same still-running session re-raises the same id
  and is swallowed even if the first item was resolved. The per-episode audit row
  still lands; acceptable, named honestly (reviewer correction).
- Veto × confirm flow: a consented call cannot loop on its own prompt — the route
  proceeds past `confirm-required` when `confirm:true` — and because the planner
  stacks every live condition into the one prompt the caller saw, a confirm can
  never consent to an unseen condition (second-pass fix).
- Suspend × journal scanner: emitStopped runs BEFORE the rewrite so the runId keys
  on the live startedAt — op-key dedupe with the scanner's observed-stopped holds.
- Suspend × stop-all/emergency-stop: untouched — those still DELETE state (a stop is
  not a move).
- Suspend × pin/release ordering: suspend runs BEFORE pin+release so the re-fired
  carrier pull reads the final, consistent file.

## 6. External surfaces
POST /pool/transfer gains a response field (`autonomousRunSuspended`) and a new
confirm prompt — additive. The NL arm gains one conversational prompt. CLAUDE.md
template + PostUpdateMigrator migration ship in this change (Agent Awareness +
Migration Parity): new installs and deployed agents both learn the consent gate.
No new mesh verbs, no protocol bump (that arrives with the drain verb).

## 7. Multi-machine posture (Cross-Machine Coherence)
The breaker is per-machine local state over local terminate attempts — no
replication, no cross-machine reads on the reaper tick (spec hot-path rule). The
veto/suspend read only the local run registry; the cross-machine arm rides the
already-replicated coherence journal (`stopped` emit) and the existing carrier.
Phase C: nothing here assumes 2 machines, a LAN, or interactivity — the breaker
scales per-session O(1); the veto's registry read is one directory listing
regardless of pool size; headless VMs run the identical path.

## 8. Rollback cost
Breaker: `topicMovedVetoBreakerAttempts` is plain config; setting it very high
restores the old retry-forever behavior (and `topicMovedCloseout:false` disables the
rule wholesale, as before). Veto/suspend: the planner dep is optional — reverting
the two wiring sites restores pre-WS1.4 behavior byte-for-byte; a suspended state
file is manually resumable (`active: true`, delete the markers). No data migration,
no state repair. Revert-and-release covers all of it.

## Second-pass review
REQUIRED (session lifecycle: reaper kill loop + transfer dispatch). Independent
reviewer response appended below.

<!-- second-pass reviewer response appended below by the independent reviewer -->

### Independent second-pass review — round 1 (2026-06-12)

**Concern raised: confirm:true on the autonomous-run prompt silently consents to the
offline-target gate the user never saw, and `suspendAutonomousTopicForMove` can
report `suspended: true` while having suspended nothing.**

Summary of the round-1 verdict (full notes in the review record): the WS1.2 breaker
half was confirmed correct and well-tested without reservation (only-real-vetoes
counting, exactly-once open/escalation, no-strand fall-through, all four episode
resets, throw-proof attention wiring). The WS1.4 half had two real defects — (1) the
stacked-gate consent collapse: the autonomous veto's early return suppressed the
offline prompt, and the route's confirm:true suppression let a confirm consent to a
condition the caller was never shown; (2) a latent silent false-success: the
suspend's `active: true` flip regex was stricter than the quote-tolerant
`readField`, so a quoted-active file would be reported suspended while the run
stayed live. Plus two wording corrections: the breaker attention dedupe is per
session lifetime (not per episode), and the artifact should state outright that
nothing auto-resumes a carried run on the receiving machine. Both defects were
fixed and both corrections folded into the artifact before commit (see "Second-pass
fixes folded in" above).

### Independent second-pass re-verification — round 2 (2026-06-12)

**Concur — both fixes verified.**

1. **Consent collapse FIXED.** All three consent conditions evaluate unconditionally
   into one `consents` array with no early return between them
   (TransferByNickname.ts:112-131); `detail` is the '+'-joined list and the prompt
   joins every condition's sentence (:135-136); the triple-stack is test-pinned
   (TransferByNickname.test.ts:139-151). The route passes `autonomousRunActive`
   unconditionally (routes.ts:10609-10627), the only 409 branch requires
   `confirm !== true` (:10638) so confirm:true falls through to execute (no loop),
   the 409 echoes `detail` (:10641), and the holder-proxy forwards `confirm`
   (:10564). The NL arm relays the stacked prompt for free (server.ts:14373-14375)
   and never executes a confirm itself. Residual (non-blocking): the generic
   prompt→confirm TOCTOU (a condition going live between the 409 and the retry) —
   the `detail` echo is the natural hook for an `expectedDetail` handshake if that
   window ever matters.
2. **Suspend false-success FIXED — structurally, not regex-patched.** The post-flip
   verification gate re-reads with the same `readField` the veto uses and returns
   `{suspended:false}` with no emit and no write when the flip did not land
   (AutonomousSessions.ts:213-217). Adversarial counterexample search (quoted,
   unspaced, trailing-whitespace, CRLF, malformed-quote forms): every shape
   `readField` accepts as 'true' is either flipped or caught by the gate; the only
   constructed escape (duplicate active keys) is one where all readers already
   treat the run as inactive — reader and suspend agree, no system-visible false
   success. Idempotent re-suspend refreshes markers without emitting (:206-228,
   :232); honest no-op and missing-file paths verified byte-identical/false; the
   atomic same-dir temp + fsync + rename path is unchanged (:234-242).
3. **Suite green, artifact accurate.** 51/51 across the three test files;
   `tsc --noEmit` clean. The artifact records both fixes, the no-auto-resume
   property, and the per-session-lifetime dedupe wording. The dedicated tests added
   for both fixes would each have failed against the originally-reviewed code.

No regressions found.
