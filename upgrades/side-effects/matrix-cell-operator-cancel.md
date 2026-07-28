# Side-Effects Review — matrix-cell-operator-cancel

**Change:** Adds operator-cancel for an in-flight account×machine matrix cell — a
target-local route `POST /subscription-pool/follow-me/enroll/:id/cancel`, a fronting
relay `POST /subscription-pool/follow-me/cancel`, two `PendingLoginStore` hardening
tweaks, two `EnrollmentWizard` pass-throughs, a dashboard Cancel button, and a one-clause
CLAUDE.md awareness addition. Dark behind `multiMachine.accountFollowMe`.

**Spec:** `docs/specs/matrix-cell-operator-cancel.md` (converged iter 2, approved).

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

- A cancel against a `completed`/`abandoned` login returns a calm idempotent `200`
  (`cancelled:false, alreadyTerminal:true`) — it does NOT reject; correct.
- A cancel while a `submit-code` is in flight returns `409` ("try again in a moment").
  This is intentional and momentary (the ~2s credential-poll window) — the operator can
  re-tap. It is the right call: cancelling mid-credential-write would strand a partial
  credential. Not an over-block.
- Malformed id (`^[a-z0-9-]+$` fail) → `404`. The store's own `ID_RE` is identical, so a
  malformed id could never name a real login anyway — no legitimate input rejected.

## 2. Under-block — what failure modes does this still miss?

- **Peer cancel when the peer is offline** → honest `502` (the relay can't reach it); the
  peer's pane keeps running until that machine's next enroll pre-cleans it. Surfaced to the
  operator, not silently swallowed.
- **Crash between abandon and pane-kill** → orphaned pane. Self-heals on the next enroll
  (enroll-start pre-cleans the slot's pane before re-spawning). Accepted (D2).
- **Mandate not revoked** on cancel (D4) — a bounded, re-mint-only, 1h-expiring mandate
  lingers. Grants no standing authority; accepted residual.
- **configHome slot not wiped** (D3) — a deliberate decision (wiping could clobber a valid
  prior credential for the same account); stale-slot hygiene is the existing
  credential-coherence path's job.

## 3. Level-of-abstraction fit

Correct layer. The route family already exists (`start-cell` mints; `submit-code` operates
on an in-flight login). Cancel is a peer of `submit-code` ("operate on an existing login")
and is placed in the same route closure, sharing the `followMeSubmitInFlight` guard. The
store-level terminal guard + `issue()` replace push correctness DOWN to the store (defense
in depth) rather than relying on route logic alone. The pane teardown uses the SAME raw
`tmux kill-session` the spawn (`server.ts:10713`) uses — not a higher-level helper that
turned out to be a no-op for these unregistered panes.

## 4. Signal vs authority compliance

The route holds de-escalating authority (kills a pane, abandons a record) gated by Bearer
auth + the dark flag. It is NOT a brittle detector with blocking teeth — it reuses the
existing structural API-edge gates (auth, `^[a-z0-9-]+$` validation, terminal-state
idempotent read, the in-flight 409). No content/intent judgment is made; the "should I
cancel?" decision is the operator's tap, not an inferred classifier. The `transition()`
terminal guard is pure mechanics (refuse a terminal→terminal flip), not a judgment gate.
Compliant with `docs/signal-vs-authority.md` (the exempted "structural guard at the edge /
idempotency mechanics" class).

## 5. Interactions

- **Shares `followMeSubmitInFlight` with submit-code** — cancel reads it (409 if held). It
  never writes it, so it can't deadlock submit-code. Verified the cancel route is colocated
  in submit-code's closure (it references the same `Set`).
- **`issue()` change touches ALL callers** — but the only production caller is
  `EnrollmentWizard.start()` (verified: the other `.issue(` hits are the unrelated mandate
  store). start-cell only reaches `issue()` after its reuse pre-check fails on a live-pending
  record, so any same-id record at `issue()` is non-pending → safe to replace.
- **`transition()` terminal guard** affects `complete()` + `abandon()` (both route through
  it). It only blocks terminal→terminal; normal `pending→completed`/`pending→abandoned`
  unaffected. `reissue()` does not call `transition()` and already guards terminal states.
- **Cancel vs start-cell reuse** — abandon-first makes the record non-reusable before the
  cell clears, so start-cell's reuse path can never hand out a cancelled login's URL.
- No double-fire / shadow: the relay and target-local route have distinct paths
  (`/follow-me/cancel` vs `/follow-me/enroll/:id/cancel`); `:id` cannot match the literal
  `start`/`cancel` segments.

## 6. External surfaces

- **Dashboard Cancel button** — a new operator-visible affordance on the in-progress (◷)
  matrix cell, behind the dark dev-agent gate. Mobile-first (full-tap-target button,
  optional native confirm that degrades to proceed under headless). Ships with the npm
  package (no migration).
- **Two new HTTP routes** — dark behind `multiMachine.accountFollowMe` (503 when off). No
  new config key.
- **No new external network egress** beyond the existing same-mesh relay hop (Bearer-authed,
  to this agent's own paired machines only — `resolvePeerUrls`). No credential ever crosses.
- Timing/runtime dependence: only the momentary submit-in-flight 409 (a real, transient
  condition the operator retries through).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This change touches an operator surface (`dashboard/subscriptions.js` — the Cancel
button on the in-progress matrix cell).

1. **Leads with the primary action?** Yes. The Cancel button is the single,
   visible action on an in-progress (◷) cell — a full-tap-target `<button>Cancel</button>`
   rendered inline beside the status glyph on every poll re-render (not collapsed,
   not below the fold, no explanatory prose in front of it).
2. **Zero raw internals as primary content?** Yes. The cell shows the glyph + the
   word "Signing in…" + the "Cancel" button; on tap, a plain status line
   ("Cancelling…" → "Cancelled — you can set this up again.") or the route's
   plain-English error. No JSON, no fingerprints, no config paths, no slugs. The
   `loginId`/`machineId` ride as `data-*` attributes (support metadata), never shown.
3. **Destructive actions de-emphasized?** N/A in the harmful sense — Cancel is
   itself the *reversing* (de-escalating) action, fully reversible (re-tap "Set up"
   to redo). It is a small single button, optionally guarded by a native confirm
   ("Cancel this in-progress setup?"). There is no separate destructive control to
   demote; the constructive "Set up" path reappears after a cancel.
4. **Plain language + phone width?** Yes. "Cancel" / "Signing in…" / "Cancelled —
   you can set this up again." read the way a non-engineer would say them; the
   button is a real tap target in the existing mobile-responsive matrix grid (same
   cell layout as the shipped "Set up"/"Submit" buttons), no horizontal scroll, no
   truncated table hiding the action.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-write (relay).** A `PendingLogin` + pane live on the machine running the login
subprocess; the target-local route is machine-local by necessity. Cross-machine reach is the
fronting relay `follow-me/cancel`, dispatching by `machineId` to self-loopback or the owning
peer over the authed mesh hop — the SAME proven pattern as `follow-me/submit-code`. The
dashboard always calls the relay, so a peer cell cancels correctly; an offline peer yields an
honest 502. No durable state strands on topic transfer (a PendingLogin is not topic-scoped);
no generated URL crosses a machine boundary. The earlier self-only draft (which would have
silently 404'd peer cells) was rejected in convergence — this is the corrected posture.

## 8. Rollback cost

Single `git revert`. Pure additive surface behind an existing dark flag. The two store
changes are backward-compatible (the terminal guard only PREVENTS a clobber that should
never happen; the `issue()` replace only RELAXES a throw). No data migration — `abandoned`
is already a valid terminal state the store + sweeps handle today. No agent-state repair. The
auto-merger handles the merge; a bad merge is one revert.

---

## Second-pass review

_(High-risk: touches a block/allow decision surface — a kill path + a dark gate + the word
"gate". Reviewer appended below.)_

An independent second-pass reviewer audited the actual implementation code (not just the
spec) against the artifact, line by line. Findings: **all [OK]** — kill targets the correct
pane with no injection (derived from the stored record, not `req.params.id`; `id` regex-gated
`^[a-z0-9-]+$`; no shell); gate order exactly as specified with abandon-before-kill; the
`@silent-fallback-ok` tag is correct and both catch ratchets pass; the `transition()` terminal
guard cannot break `complete()`/`reissue()`/normal flows; `issue()` replace has a single
production caller (`EnrollmentWizard.start`) and still throws on a live-pending dup; the
dashboard Cancel is on the durable cell, no PIN, confirm degrades under jsdom; template↔migrator
parity + idempotency hold; the relay adds no SSRF surface beyond submit-code (own paired
machines only, `encodeURIComponent`'d id, no `code` body); no new CI ratchet trips. One
**[MINOR]**: the submit-in-flight 409 is a momentary retry-through window (documented in §1) —
not a defect. No blockers, no material issues, no signal-vs-authority violation.

**Verdict: Concur with the review.**
