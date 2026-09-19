# Side-Effects Review — quota-bar severity colours

**Change:** `dashboard/subscriptions.js` `quotaBar()` now derives a severity band
(`ok` / `warn` / `critical`) from the already-clamped 0–100 percent and puts it on the
fill's class; `dashboard/index.html` gives each band a colour. Thresholds: ok <75,
warn 75–89, critical ≥90.

**Tier:** 1 — presentation-only, 3 files, no `src/` runtime surface, no new capability,
no migration, no irreversibility. (Note: `dashboard/` is outside
`scripts/instar-dev-precommit.js`'s `inScope()` filter, so the gate does not demand a
trace here. The artifact is produced anyway — see §9.)

## Phase 1 — Principle check (signal vs authority)

**Does this change involve a decision point — something that gates information flow,
blocks actions, filters messages, or constrains agent behaviour?**

No. `quotaSeverity()` is a pure function from a number the renderer already holds to one
of three CSS class literals. It has no consumer other than the DOM. It does not gate,
block, filter, route, shed, alert or gate-keep anything, and nothing reads it back.

The valid-reason category is "presentation of data already computed and already
displayed." The numeric quota that placement, proactive-swap, load-shedding and the
quota brake consume is untouched, and those subsystems keep their own thresholds — this
change deliberately does not unify them (see §5).

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

Nothing is rejected; there is no accept/reject decision. The nearest analogue is a
misleading colour. The band is computed from `clampPct()`'s output, so the reachable
inputs are exactly the integers 0–100 and the three bands partition that range with no
gap and no overlap. A non-finite or missing reading clamps to 0 and renders green — the
same "empty bar" a missing reading already rendered, so this does not invent a
reassuring colour for absent data. An account with no quota reading at all still takes
the separate `sub-account-noquota` path and draws no bar.

## 2. Under-block — what failure modes does this still miss?

- **A stale reading still looks authoritative.** A bar polled ten minutes ago renders
  the same as one polled ten seconds ago; colour does not encode freshness. This is
  pre-existing (the bar itself had the same property) and out of this change's reach.
- **0% green is ambiguous** between "genuinely unused" and "clamped from an unusable
  reading." Also pre-existing — the width was already 0 in both cases — and the row's
  status text is what distinguishes them.
- **Colour does not distinguish 90% from 100%.** Deliberate: both mean "do not plan
  work here", and a fourth band buys resolution the operator does not act on differently.
- **The 5-hour and weekly bars are banded independently.** An account green on 5-hour and
  red on weekly shows both, which is correct — they are different limits — but there is
  no single per-account "worst band" summary. Not attempted here.

## 3. Level-of-abstraction fit

Right layer. The severity is a property of *this view* of the number, not of the number,
so it belongs in the renderer that owns the bar. Pushing it server-side would mean the
API asserting an operational verdict ("this account is critical") that routing does not
share, which would be a stronger claim than the data supports and would invite consumers
to treat a presentation band as authority.

A smarter gate does exist for the operational question — `QuotaTracker`, the proactive
swap's measured threshold, and the placement quota gate — and this change deliberately
does **not** feed them or read from them. It is a sibling view, not a parallel authority.

## 4. Signal vs authority compliance

Compliant, in the strongest available form: this produces neither. It holds no blocking
authority, and it is not even a signal (nothing consumes it programmatically). The
brittle-check-with-authority failure mode this question exists to catch is structurally
unreachable — the only consumer is CSS.

The constants are exported (`QUOTA_WARN_PCT`, `QUOTA_CRITICAL_PCT`) so the tests assert
against the same numbers the code uses. That export is a hazard worth naming: a future
change that imports them into a routing decision would silently convert a presentation
band into an authority. The file comment states the boundary; if that ever happens it
should be a reviewed change, not an import.

## 5. Interactions

- **Does it shadow another check?** No. It does not participate in any check.
- **Is it shadowed?** The `.sub-quota-fill` base rule still carries the green gradient
  and the three band rules follow it with equal-or-higher specificity
  (`.sub-quota-fill.sub-quota-warn` is one class more specific), so the band always wins
  and the base rule remains a correct fallback if a future caller builds a fill without
  a band class. No `!important` anywhere in the chain.
- **Does it double-fire or race?** No timers, no state, no async. `quotaBar()` is called
  synchronously during render and is idempotent.
- **Threshold divergence is real and intentional.** The proactive swap's measured
  threshold (default 80%) sits *between* this change's warn (75) and critical (90)
  boundaries, so an operator can see an amber bar on an account the swap has not yet
  moved off. That is honest — amber means "getting tight", not "the swap fired" — but it
  is the most likely question this change generates, and it is why the two numbers are
  not wired to each other.

## 6. External surfaces

- **Visible to the operator:** yes — that is the point. The change is additive to the
  existing view; no element is removed, renamed or reordered, and the percent text,
  reset countdown, labels and layout are byte-identical.
- **Visible to other agents / systems:** no. No API response, no state file, no message,
  no log line changes. The class is never serialized off the page.
- **Accessibility:** colour is redundant with the always-present "N% used" text, so no
  information is conveyed by colour alone. The three fills stay well above the track
  background in luminance on the dark theme (the dashboard has no light theme and no
  `prefers-color-scheme` block, so there is no second palette to maintain). Amber
  `#f59e0b` and red `#f87171` are both already in the dashboard's existing palette, so
  this introduces no new colours to the page.
- **Timing / runtime conditions:** none depended on.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, with no coherence surface.** The dashboard is served as static
assets by whichever machine the operator has open, and the banding is computed in that
browser from whatever account rows that page already fetched. There is no state to
replicate, nothing to proxy on read, and no durable record that could strand on a topic
transfer.

The pool-scope account view (`GET /subscription-pool?scope=pool`) is unchanged, and rows
merged from a peer machine render through the same `quotaBar()` as local rows — so a
mixed-machine list is banded consistently rather than one machine's rows being coloured
and another's not. Because the asset ships inside the instar package, a machine still on
an older version simply renders the old all-green bars until it updates; the two versions
do not disagree about any value, only about colour. No user-facing notice is emitted, so
there is no one-voice gating question. No URL is generated.

## 8. Rollback cost

Near-zero and immediate. Reverting the commit restores the previous rendering exactly —
there is no persisted state, no migration, no agent state to repair, and no consumer to
un-wire. A hot-fix release is not required for correctness: even left in place, a wrong
threshold only mis-colours a bar whose number is still printed next to it. An operator
who dislikes the bands before a release can neutralise them by removing three CSS rules.

## 9. Follow-up raised, not deferred

`inScope()` in `scripts/instar-dev-precommit.js` does not cover `dashboard/`, although
the dashboard ships to every install and is the operator's primary read surface. That is
a genuine gap in the gate — a dashboard change can land with no artifact and no trace.
This artifact was produced regardless, and the gap is filed as its own item rather than
widened into this PR (changing the gate's scope is a gate change, with its own blast
radius, and belongs in a change that can be reviewed on those terms).
