# Side-Effects Review — Subscription cell login integrity

**Version / slug:** `subscription-cell-login-integrity`
**Date:** `2026-07-15`
**Author:** `Instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

Background enrollment renewal now carries an explicit no-browser consent flag through EnrollmentWizard and FrameworkLoginDriver into production command wiring. The dashboard matrix aggregates same-cell identity truth with needs-sign-in precedence and lets durable pending state reconstruct the in-cell flow after restart.

## Decision-point inventory

- Browser-open consent — modified invariant: explicit initiation may open; timed renewal may not.
- Same-cell status precedence — modified invariant: identity drift outranks stale Active.
- Restart reconstruction — modified invariant: durable pending state outranks drifted enrollment bookkeeping.

## 1. Over-block

Renewal will not automatically focus a newly refreshed provider URL. This is intentional: an operator who did not just initiate the action must not receive unsolicited browser tabs. The refreshed link remains tappable in the cell.

## 2. Under-block

Browser suppression relies on the provider CLI honoring the standard BROWSER environment variable. The command still mints and captures the public artifact. A future provider CLI that ignores BROWSER would require provider-specific suppression; the request-level consent flag and tests make that boundary visible.

## 3. Level-of-abstraction fit

EnrollmentWizard owns initiation versus maintenance intent; FrameworkLoginDriver transports it; production spawn wiring translates it to process environment. Dashboard precedence belongs in the pure matrix model, where all durable inputs meet.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

These are deterministic consent and structured-state invariants, not heuristic interpretation. No brittle detector is given judgment authority.

## 4b. Judgment-point check

No competing-signals heuristic is added. Explicit versus timer initiation and drift/pending/active status are enumerable facts with conservative precedence.

## 5. Interactions

Initial enrollment remains browser-enabled. Renewal still replaces the stored URL/code and increments its counter. A clean active row still wins over a stale completed pending row, preserving the existing just-verified transition; pending wins only while the cell is in needs-sign-in safety state.

## 6. External surfaces

Operators stop receiving unsolicited tabs. Drifted cells change from Active to Needs sign-in and expose the existing PIN-gated flow. No secrets, tokens, new external calls, or new routes are introduced.

## 6b. Operator-surface quality

The primary repair action is directly in the affected cell; no raw identifiers lead; no destructive action is added; the existing phone-width cell flow is reused.

## 7. Multi-machine posture

Machine-local by existing credential design: a login and its browser process belong to the machine holding that credential slot. Pool-scope reads merge durable per-machine accounts and pending logins into one dashboard. No notices or generated Instar URLs are added.

## 8. Rollback cost

A hot-fix revert restores prior behavior. Stored pending-login schema is unchanged, so no data migration or state repair is required.

## Conclusion

The repair makes the cell authoritative without creating a second workflow, preserves the existing successful-enrollment ceremony, and restores browser-open consent. Clear to ship.

## Second-pass review

Not required: no messaging, session lifecycle, trust, recovery controller, sentinel, guard, or conversational judgment path is touched.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable.
