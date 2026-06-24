# Side-Effects Review — Honest Session-State Surfaces (Tier1/Tier2 standby honesty + paused-queue notice correctness)

**Version / slug:** `honest-session-state-surfaces`
**Date:** `2026-06-24`
**Author:** `echo`
**Second-pass reviewer:** `general-purpose (independent Phase-5 diff review)`

## Summary of the change

Two small honesty fixes to the standby/reap user-facing surfaces, both signal-only.
**Finding (b)** lifts the existing Tier-3 honest stuck-state classifier
(`classifyStuckSignature` — rate-limited / policy-wedge / context-wedge /
context-too-long) into PresenceProxy **Tier 1** and **Tier 2** so a live-but-failing
session is reported with its REAL reason at the 20s / 2-minute marks instead of
"actively working". It is gated behind a dev-dark flag
`monitoring.standbyHonestyTiers.enabled` (OMITTED from ConfigDefaults → resolved via
`resolveDevAgentGate`; live on a dev agent, dark on the fleet). **Finding (c)** fixes a
false "A restart is queued — I'll bring it back" claim when the ResumeQueue is paused:
it adds a NEW `ResumeQueue.hasClaimableQueuedEntryFor` (= `hasLiveQueuedEntryFor && !isPaused()`)
and re-points ONLY the ReapNotifier copy consumer at it, leaving the paused-blind
`hasLiveQueuedEntryFor` (ownership) for the PromiseBeacon I2 double-spawn guard. Files:
`src/monitoring/PresenceProxy.ts`, `src/commands/server.ts`, `src/core/types.ts`,
`src/core/devGatedFeatures.ts`, `src/monitoring/ResumeQueue.ts`, plus 4 test files.

## Decision-point inventory

- `PresenceProxy Tier 1 / Tier 2 standby copy` — modify — flag-ON substitutes the honest stuck reason (or suppresses the message under one-voice) for "working" copy; flag-OFF byte-identical.
- `ReapNotifier "restart is queued" line (via ResumeQueue predicate)` — modify — now reads claimability (false while paused) instead of ownership; no flag, pure correctness.
- `PromiseBeacon I2 double-spawn coordination guard (server.ts:11980)` — pass-through — still reads the unchanged paused-blind `hasLiveQueuedEntryFor` (ownership). Deliberately UNCHANGED.

---

## 1. Over-block

The change has no block/allow surface — it changes message TEXT and suppresses a
specific false claim. (b) The honest pre-check can only substitute the standby message
string or suppress it under one-voice ownership; it never blocks a session, a send, or
a tier. (c) Suppressing the "restart is queued" copy while paused omits one notice LINE,
never a whole notice and never a queue entry. "No block/allow surface — over-block not applicable."

---

## 2. Under-block

Not applicable (no block surface). The honest classifier is inherited as-is (tail-gated,
same false-positive profile as the established Tier-3 usage — the early tiers do not
widen its input surface). The claimability predicate is a strict conjunction over the
already-shipped ownership predicate, so it cannot pass a case the ownership predicate
already rejects. "No block/allow surface — under-block not applicable."

---

## 3. Level-of-abstraction fit

Right layer in both. (b) reuses the existing classifier (a detector) and feeds the
existing standby-message emission path — it adds NO new detector and NO new parse
surface; recovery stays with the Tier-3 block and the sentinels (the early tiers only
REPORT or stay silent). (c) adds a sibling read accessor on the store that already owns
the queue state (`ResumeQueue`) rather than re-deriving pause state in the caller — the
authority over "is this claimable?" lives with the queue.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal (a message string / a boolean read) consumed by existing smart gates and emission paths; it holds NO new block authority.

(b) only alters which message string is sent, or sends none when a recovery sentinel
owns the voice — it NEVER gates scheduling (`scheduleTier` runs in every branch),
initiates recovery, spends, or egresses. Every uncertainty (no snapshot, classifier
returns null/throws, recovery owner present) fails toward today's behavior. (c) is a
read-accessor correctness fix; the I2 guard's blocking decision still reads the
unchanged ownership predicate, so the only coordination authority in play is untouched.

---

## 5. Interactions

- **Shadowing:** (b) The honest pre-check is placed AFTER the existing quota
  short-circuit (`detectQuotaExhaustion`) and AFTER the idle/finished checks in both
  fireTier1 and fireTier2, so it never shadows the quota or "agent finished" paths
  (quota panes — the rate-limit form — are still handled by the pre-existing quota
  short-circuit, which the lift sits below; the lift's incremental value is the wedge
  set quota does not catch). It is placed BEFORE the LLM block, so a stuck session never
  reaches the LLM "working" summary.
- **Double-fire:** (c) The whole point — the I2 guard keeps deferring to the queue while
  paused (reads ownership, still true), so a PromiseBeacon escalation cannot double-spawn
  a revive for a paused-frozen topic. A naïve single-predicate paused-aware edit would
  have re-opened exactly that double-spawn; the split predicate prevents it.
- **Races:** No new shared state. (b) reuses the existing per-topic PresenceState and the
  same persist/schedule tail. (c) reads `ResumeQueue` state through its existing accessors.
- **Feedback loops:** None — message text and a boolean read have no feedback into the systems they describe.

---

## 6. External surfaces

- Other agents: none.
- Install base: (b) ships dark on the fleet (dev-gate) → no fleet behavior change until a
  deliberate flip; (c) ships live but only removes a false claim line.
- External systems: the honest standby message and the reap notice both flow through the
  EXISTING `sendMessage` / Telegram formatter+escape path — no new outbound surface, no raw send.
- Persistent state: none changed. ResumeQueue entries are untouched (paused entries
  remain queued and revive normally on unpause).
- **Operator surface (Mobile-Complete Operator Actions):** No operator-facing actions —
  both surfaces are passive notifications the agent emits; there is nothing for the
  operator to do/tap. Not applicable.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. This change touches no dashboard renderer/markup
file, no approval page, and no grant/revoke/secret-drop form. It alters two passive
agent-emitted notification strings (a 🔭 standby line and a 🪦 reap-notice line); there
is no operator form, button, or page in the diff.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** — both surfaces are per-machine-local honesty surfaces with a
concrete reason each:

- **(b)** `PresenceProxy` already runs under the WS3 one-voice speaker election (only the
  topic's OWNER machine speaks 🔭). The honest classifier reads the LIVE LOCAL tmux pane of
  a session running on THIS machine — there is no remote session to classify, so it is
  correctly machine-local: the machine serving the topic reports honestly about the session
  it is actually running. User-facing notice → one-voice gating is already inherited from
  the existing PresenceProxy speaker election (the pre-check sits inside that gate; the
  SUPPRESS branch also honors the recovery-owner one-voice rule).
- **(c)** `ResumeQueue` is a durable PER-MACHINE queue (it holds a host-local lock
  precisely to forbid two machines sharing its state). Its `paused` flag and entries are
  machine-local, and the reap notice is emitted by the machine that reaped the session, so
  the paused-guard is correctly local — it suppresses the claim on the only machine that
  could (or could not) honor it. No durable state strands on transfer (entries are
  untouched); no URLs are generated.

No `multiMachine.*` config, no replicated-store work, no pool routes touched.

---

## 8. Rollback cost

- **Hot-fix release:** pure code change — revert and ship a patch. (b) is additionally
  flag-gated, so disabling `monitoring.standbyHonestyTiers.enabled` (or running on the
  fleet, where it is already dark) reverts Tier 1/2 to byte-identical-to-today wording
  without a code change.
- **Data migration:** none — no persistent state added or changed.
- **Agent state repair:** none — no agent needs notification or reset.
- **User visibility:** none during rollback — reverting (b) restores "actively working";
  reverting (c) restores the (incorrect) "restart is queued" claim, a cosmetic regression
  only, with no behavioral loss.

---

## Conclusion

This review produced no design changes — the spec's convergence had already resolved the
two load-bearing constraints this review re-verifies: (b) scheduling is never gated (the
honest pre-check substitutes the message string or suppresses it, then falls through to
the existing scheduling tail in every branch, including SUPPRESS), and (c) the shared
`hasLiveQueuedEntryFor` stays paused-blind for the I2 double-spawn guard while a NEW
claimability predicate feeds only the user-facing copy. The 3-tier test suite pins both
sides of each boundary, including the I2-guard regression assertion (ownership survives a
pause) and the no-leak contract at the new Tier1/2 callsite. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** general-purpose (independent Phase-5 diff review)
**Independent read of the artifact: concur**

The independent reviewer read the real staged diff and the surrounding source (the full
`fireTier1`/`fireTier2` methods, `maybeStuckMessage`, `ResumeQueue.hasLiveQueuedEntryFor`
/ `hasClaimableQueuedEntryFor` / `isPaused`, and server.ts lines 7219/7244/7501/11980),
checking specifically: (1) the next tier is scheduled in EVERY branch of the new
pre-check (string / SUPPRESS / null); (2) the SUPPRESS branch sends no "working"
fallback; (3) the pre-check sits after the quota/idle short-circuits; (4)
`hasLiveQueuedEntryFor` is left paused-blind for the I2 guard; (5) only the ReapNotifier
copy reads the claimable predicate; (6) the no-leak contract holds; (7) no control-flow
bug from the fireTier2 brace restructuring. Findings are recorded below.
