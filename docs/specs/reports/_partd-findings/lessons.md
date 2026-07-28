# Part D — FOCUSED re-convergence findings (lessons-aware + FOUNDATION lens)

Scope: `### Part D` of `autonomous-registration-guarantee.md` (the `recentUserMessage`
stub→real promotion), plus Part B's D8 invariant and the Frontloaded Decisions, read
against the codebase and `docs/STANDARDS-REGISTRY.md`. Grounded in
`docs/specs/_PART-D-GROUNDING.md`.

All findings below are NEW material — not present in
`autonomous-registration-guarantee-convergence.md` (which predates Part D and only
references the stub indirectly via the D8 invariant).

---

## FINDING 1 (HIGH — blast-radius / honesty gap) — Part D undercounts what the promotion turns on

**Verified fact (code):** `recentUserMessage` is consumed at SIX call sites across
`src/core/ReapGuard.ts`, NOT one:

| line | method | window | what it gates |
|------|--------|--------|----------------|
| 137  | `evaluate()` | `recentUserWindowMs` (**30 min**) | **Gate I — a STANDALONE recent-user-message KEEP**, independent of any commitment |
| 149  | `evaluate()` | `staleCommitmentWindowMs` (8h) | Gate J — the open-commitment KEEP corroboration |
| 221  | `workEvidence()` | `recentUserWindowMs` (30 min) | `recent-user-message` work-evidence probe |
| 238-239 | `workEvidence()` | `staleCommitmentWindowMs` (8h) | `open-commitment` work-evidence probe |

Part D's prose (spec lines 158-164, 169-170) repeatedly calls the affected surface
**"ReapGuard's open-commitment KEEP-probe (Gate-I)"** — conflating two distinct gates.
In the actual code, **Gate I (line 137) is a wholly separate standalone 30-minute
recency KEEP** that has nothing to do with commitments; the open-commitment veto is
**Gate J (line 149)**. Promoting the stub activates BOTH — so the promotion also
switches on a brand-new "keep any session that got a user message in the last 30 min"
veto that Part D never names or risk-analyzes.

**Why it matters (FOUNDATION):** Part D's load-bearing safety argument ("the change is
NARROW — requires BOTH a qualifying open commitment AND an inbound user message inside
the window") is true for Gate J but **false for Gate I**, which needs ONLY a recent user
message (no commitment required). The real KEEP-behavior delta on the live (non-dark)
path is wider than the spec claims: every topic-bound session messaged in the last 30
min becomes un-reapable. That is still the SAFE direction (it retains likely-in-use
sessions and never reaps something active), so the conclusion survives — but the spec is
NOT honest about the true scope of the behavior flip, and a reaper-class review must see
the full surface, not a narrowed one. **Required fix:** Part D must (a) correct
"Gate-I"→ name Gate I AND Gate J distinctly, (b) acknowledge the `workEvidence()` probes
(221/238) also go live, and (c) extend the safe-direction argument to cover the
standalone Gate-I recency KEEP and its 30-min `recentUserWindowMs` window (separate from
the 8h `staleCommitmentWindowMs` Part D currently fixates on).

## FINDING 2 (MEDIUM — Signal-vs-Authority is honored; one caveat) — workEvidence() probes feed eligibility, not just KEEP

`workEvidence()` (ReapGuard.ts:194+) is the "CHOKEPOINT FALLBACK" that stamps
resume-eligibility evidence. Lines 221/238 emit `recent-user-message` /
`open-commitment` WorkEvidence today **using the same stubbed `()=>false`** — so they
emit nothing. Once `recentUserMessage` is real, these probes start emitting real
WorkEvidence on the **fallback revival path** too, independent of Part B's new
injection. Part D's containment argument ("revival path ships dark, so no loop") is
built around the **Part B injection** being dark — but the `workEvidence()` chokepoint
fallback is a SEPARATE, already-shipped revival contributor that the promotion also
un-stubs. The spec does not establish that this fallback path is equally dark/bounded.

This does NOT break Signal-vs-Authority (the authority — `evidenceEligible`/drainer —
is unchanged; the commitment/message remains a signal). And the existing Gate-J/probe
agreement comment (ReapGuard.ts:233-242, the 2026-06-13 fix) means evaluate() and
workEvidence() use the IDENTICAL `staleCommitmentWindowMs` corroboration, so they still
AGREE after promotion — the anti-loop invariant holds for the commitment path. **But**
Part D should explicitly state that un-stubbing also activates the workEvidence()
fallback emitters, and confirm those are bounded by the same resurrection cap (the spec
asserts the cap for the Part-B injection path; it should assert it covers the fallback
path too, or note the fallback only fires when a killer reaches the chokepoint with no
evidence).

## FINDING 3 (PASS) — Part D is HONEST that the guard was a latent dead guard, and the deferred comment IS owned

- The spec's BUILD-TIME FINDING banner (lines 23-33) and Part D body (158-164) state
  plainly: *"today ReapGuard's open-commitment KEEP-veto is INERT"* / *"a v1 STUB"* /
  *"the feature is dead."* This is exactly the disclosure
  **Standard "No Silent Degradation to Brittle Fallback"** (`STANDARDS-REGISTRY.md` line
  125) demands: *"A revival guard that is disabled, inert, or skipped is itself an
  incident and must announce itself; it may never fail silent."* Part D treats the inert
  guard as an incident to surface and fix, not a silent flip. **This is a genuine
  honor of the standard, not lip service.** (Caveat: per FINDING 1, the disclosure is
  honest about Gate J but silent about Gate I — the honesty is incomplete in scope.)
- The codebase's own deferred comment (server.ts:13524-13529: *"Promoting to a real
  message-recency query is a tracked tuning follow-up"*) is engaged head-on, not papered
  over: Part D and the grounding doc both cite it by location and convert the deferral
  into an owned, soak-gated change with a risk analysis. This is the correct treatment
  of a known-deferred decision per **Close the Loop** — the loop the codebase opened is
  being deliberately closed, not silently inherited.

## FINDING 4 (PASS, with FINDING-1 caveat) — the 2026-06-13 loop lesson IS genuinely honored

The 2026-06-13 lesson (encoded in ReapGuard.ts:233-242 and DEFAULT_REAP_GUARD_OPTIONS):
evaluate() KEEP and workEvidence() eligibility MUST agree on what an open commitment
means, or an idle session is killed (stale ⇒ reap) then revived (open-commitment ⇒
eligible) forever. Part D's **shared-predicate design genuinely honors this**: one real
`recentUserMessage`, wired once, read by BOTH the KEEP path and the new GAP-B
eligibility, *"computed from the identical truth and cannot disagree"* (spec 170-171).
That is the structurally-correct fix — agreement by construction, not by parallel
re-implementation.

Two reinforcing facts make the loop genuinely impossible here:
1. **The shared predicate** removes the disagreement at its root (Part D's core design).
2. **The de-risking insight** (grounding line 29-31, spec 189-195): the Part-B
   commitment-injection revival path ships dark/dryRun, so even with `recentUserMessage`
   live, no revival fires ⇒ no reap→revive→reap loop is constructible. The E2E test
   (spec 270-272) pins this: kill→revive against a fresh-commitment topic with NO recent
   user message → asserts NO loop.

**Caveat (ties to FINDING 1 & 2):** the "no loop because injection is dark" argument is
sound for the Part-B injection path but does NOT, as written, cover the already-shipped
`workEvidence()` fallback emitters (221/238) that the same promotion un-stubs. Because
those use the identical `staleCommitmentWindowMs` corroboration as evaluate() (the
2026-06-13 fix is already in place at ReapGuard.ts:233-242), they still AGREE with KEEP
and cannot loop on the commitment basis — so the lesson is NOT contradicted. But Part D
should state this explicitly rather than leaving the reader to verify the in-code
agreement comment survives the un-stubbing.

## FINDING 5 (LOW — fail-open D7 is correct and aligned)

The extended D7 (spec 197-199): a `queryInbox` throw ⇒ predicate returns `false` ⇒ no
KEEP, no injection ⇒ exactly today's behavior. This is the correct fail-open direction
and matches the existing ReapGuard contract (`blockedReason` catches and resolves to
KEEP on guard-error; `workEvidence` probes swallow throws and contribute nothing). One
subtlety to ground at build: ReapGuard's existing closures use **"cannot tell → protect"**
for `activeCommitmentForTopic`/`activeSubagentCount` (KEEP on error), but `recentUserMessage`
fail-open is **"cannot tell → DON'T keep"** (return false). Both are individually safe in
their own gate (a recency miss just falls through to the next guard; it never *causes* a
reap by itself), but the spec should note the deliberate asymmetry so the build doesn't
"fix" it into a spurious KEEP. (D7 as written already picks the right direction — this is
a note to preserve it, not a defect.)

---

## VERDICT SUMMARY

- **Q1 (No-Silent-Degradation + Signal-vs-Authority):** ALIGNED. The inert guard is
  disclosed as an incident and promoted deliberately (honors Standard 118); the
  commitment/message stays a signal, the unchanged `evidenceEligible`/drainer stays the
  authority. Caveat: the disclosure's *scope* is incomplete (Gate I unnamed — FINDING 1).
- **Q2 (foundation honesty about the inert/dead guard + deliberate change):** HONEST for
  Gate J / the open-commitment KEEP, INCOMPLETE for Gate I (the standalone 30-min recency
  KEEP that the same promotion activates is never named or risk-analyzed). Not a silent
  flip, but a partially-scoped one.
- **Q3 (deferred comment ownership):** PROPERLY ENGAGED — the server.ts:13524 "tracked
  tuning follow-up" is cited and converted into an owned, soak-gated change. Not papered
  over.
- **Q4 (contradicts a documented lesson?):** NO. The 2026-06-13 shared-predicate /
  agreement lesson is genuinely honored by construction; the dark-injection containment
  holds. Residual: the `workEvidence()` fallback emitters un-stubbed by the same change
  should be named explicitly (FINDING 2/4 caveat).

**Overall: NEEDS-CHANGES (minor, scoping-honesty).** Part D's *engineering* is correct
and its safety conclusion survives, but it must (1) correct the "Gate-I" conflation and
name the standalone Gate I recency KEEP it also activates, with that gate's own
30-min window and its safe-direction argument; and (2) acknowledge the `workEvidence()`
fallback emitters (ReapGuard.ts:221/238) that the same un-stubbing brings live, and
confirm they remain agreement-bound (the 2026-06-13 fix at lines 233-242) and
cap-bounded. These are honesty/scope corrections to a foundationally-sound part — not a
redesign.
