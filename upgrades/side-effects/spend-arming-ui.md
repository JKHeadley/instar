# Side-Effects Review — paid-door arming UI

## Summary

The routing-spend money layer's routes (`/routing-spend/plan`, `/caps/adjust`, `/freeze`) had no
screen, while the Spend tab's own copy said caps and go-live were "a later increment". This adds
the two-step arming flow and corrects that copy.

## How this arose

An operator was told arming was "one tap in the Spend tab, enter your PIN". It was not — the tab
was read-only and said so. They went looking for a PIN box that had never been drawn. That is the
same class as the enrolment failures earlier tonight: a capability described as reachable that
had no reachable surface.

## Decision-point inventory

None added. The screen holds no authority: it renders a plan the SERVER composed and posts back
the plan identity plus the operator's PIN. The server verifies the PIN and derives what to apply
from its own rendered plan. The UI cannot arm, adjust, or unfreeze anything on its own.

## 1. Over-block

`validateCaps` refuses client-side before asking for a plan: a missing ceiling, a non-number, a
non-positive value, or a daily ceiling above the lifetime ceiling. The last could arguably be
allowed (the server may accept it), but a daily ceiling that can never bind is almost certainly a
typo, and the message says why rather than just refusing.

## 2. Under-block

The client does no authorization at all — deliberately. Every real refusal (bad PIN, money layer
off, unreadable caps store, expired plan) is the server's, and the UI only renders the reason.

## 3. Level-of-abstraction fit

Plan rendering stays server-side; the client never composes the sentence the operator approves.
That is what makes "a field you never saw cannot land" true, and it would be false if the UI
built its own summary text.

## 4. Signal vs authority

The UI is pure presentation plus transport. The PIN gate is unchanged and remains server-side.

## 5. Interactions

The panel renders from the SAME `/routing-spend/caps` payload the read-only glance above it uses,
so the door list and its live/frozen wording cannot drift from the figures. Editing any input or
changing the door clears the pending plan, so a PIN can never be applied to a plan the operator
has since edited away from.

## 6. Multi-machine posture

Machine-local BY DESIGN — the dashboard is served per machine and the PIN is a per-machine
secret. Go-live already carries a `designatedMachineId` server-side; the UI does not touch it.

## 7. Failure modes

Every money-layer failure routes through `moneyLayerNote`, which distinguishes: money layer off
(names it as the operator's own switch), caps store unreadable (refusing to guess), rejected PIN,
and everything else. The default says "nothing has changed", which is true on every path because
the server fails closed. The module has no I/O and every exported function is total (tested
against undefined/null/junk).

**Security**: the PIN never appears in a preview request (pure-function test asserts it), is a
`type=password` field, is cleared on both success and failure, and is never placed in a URL. All
rendering is textContent; a hostile plan text is tested for.

## 8. Rollback cost

Delete the `spendArming` div and the `renderSpendArming(caps)` call. The module is inert without
them. No state, no migration, no config.

## Evidence

31 unit tests against the shipped module in a real DOM, plus wiring tests that assert every
`/dashboard/*.js` the page imports exists on disk — the guard against the "wired but unreachable"
shape that caused this whole thread.

Shown capable of failing, independently: leaking the PIN into the preview request fails exactly
the security test; replacing the honest 503 message with a generic one fails exactly the two
tests that pin it. A CONTROL asserts an ordinary network failure does NOT claim the money layer
is off — without it, every failure would send the operator to flip a switch that is already on.

**Not yet proven live.** The money layer is off on this agent, so the arming path cannot be
driven end-to-end until the operator enables it. That is stated rather than papered over: this
review does not claim live-channel proof it does not have.
