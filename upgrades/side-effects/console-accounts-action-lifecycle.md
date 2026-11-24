# Accounts dialogs stay with the page that opened them

## Summary

Tier 1. The dashboard now checks whether the Accounts visit and the dialog that owns an action are still open before it updates or closes that dialog. The router can refresh the Accounts list in place while the visible buttons continue to work. Two browser modules and a focused renderer test file cover the change. This repair extends the weekly-reset Accounts list candidate at 4bbed4631.

## Over-block

An already-sent request continues normally. Its dialog stops updating if the user closes it or leaves Accounts. If a dashboard PIN verification is pending when the user closes its prompt, the token from the late response cannot restart that prompt or start the requested Accounts action. The existing routes still apply the normal identity and authorization checks.

## Under-block

The page cannot cancel an in-flight sign-in, repair, or setting change just because someone navigates away. Cancellation stays available through its explicit action. A pending completion read may finish after the page closes, but its result cannot update the page or schedule another read.

## Level of abstraction

Visit ownership comes from the console router. Dialog ownership comes from the actual panel returned by the shared sheet function. A render identity applies only to initial read results. Applying it to ongoing actions would close a valid sign-in when that sign-in refreshes its own list.

## Signal and authority

Under [Signal vs Authority](../../docs/signal-vs-authority.md), panel lifetime supplies context for drawing to the browser. The server remains responsible for deciding which requests are allowed, whether they complete, and what state they change. The browser retains the same endpoint, payload and authorization adapter for each action.

## Interactions

The shared PIN prompt includes the visit checks from the Ideas navigation repair at ac1f6474671c2cc250b9babdbb68e46a341a255d. Keep the combined Accounts guard when the candidates join, since it also checks whether the dialog changed or a newer PIN check started. Once a PIN dialog is open, a late session unlock or focus timer belongs to that specific panel. Accounts checks its own panel before calling the shared close function. An older Accounts read cannot repaint a newer one. The normal refresh skips while a dialog is open.

## External surfaces and multi-machine behavior

This is browser-local presentation state. The Accounts dashboard continues to read the pooled state and sends the same machine-scoped requests. The change needs no server migration or native app update. A completed request can still be seen from another browser through the normal Accounts read.

## Rollback

Revert this renderer change to restore the earlier dialog behavior. No account, browser registration, operator session, or stored state needs to be edited for rollback. Preserve the independent Ideas guards if the two changes have already joined.

## Independent review

The reviewer found that an older PIN check could still replace another dialog on the same Accounts page. Two regressions reproduced the issue. The reviewer concurred after the updated prompt checked its dialog generation and rejected superseded checks.
