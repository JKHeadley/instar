# Side-effects review — WhatsApp + iMessage join the channel registry

**Change:** `buildUserChannelDefinitions` gains `user-whatsapp` and `user-imessage` rows, with
exported `whatsappStateFrom` / `imessageStateFrom` mappers and route wiring from
`ctx.whatsapp.getStatus().state` and `ctx.imessage.getConnectionInfo().state`.

**Decision point touched?** No new gate. This is additive read-only observability on an existing
`advisory: true` route. It does change what a caller CONCLUDES about reachability, which is why the
verdict mapping is the whole of this review.

---

## 1. Over-block

Nothing is blocked or rejected — the route is advisory and gates nothing. The over-claim risk runs the
other way and is handled: `qr-pending` is reported as `reachable-no-credential` rather than `broken`,
because the link is alive and needs a HUMAN to scan a code. Reporting it as broken would send an
operator to debug a connection behaving exactly as designed.

## 2. Under-block

The honest limit, stated in both rows' own text rather than left to assumption: `working` means the
link was up when probed. It does NOT prove a send to a particular chat or contact would land. Same
caveat the Telegram and mutual-ssh rows already carry.

Unrecognised states from either adapter map to `unknown`, never to `working`. That is the failure
direction that matters — a state this module has not seen must not read as healthy — and it is
pinned by a test.

Not addressed: neither row probes a round-trip. A true reachability proof would require sending, which
a status read must not do.

## 3. Level-of-abstraction fit

Correct, and it follows the pattern already established for Telegram and Slack: the STATE→VERDICT
mapping is an exported pure function testable without constructing an adapter, and the route supplies
live state through a narrow context. The mapping is where a wrong verdict would come from, so it is
the part that is pinned.

## 4. Signal vs authority compliance

Compliant. Pure signal on an advisory route with no blocking power. Adding rows strengthens the
registry's "absence is impossible" property — the invariant that a channel with no row cannot report
that it is missing.

## 5. Interactions

`UserChannelProbeContext` gains two required fields, so any other constructor of it must supply them
— there is exactly one (the `/channels` route), updated here. The `/channels` payload grows from 6
rows to 8; the integration test that pins the exact set and the audience partition was updated in
this change rather than left for CI to catch.

`WhatsAppLiveState` mirrors the adapter's own union. If the adapter adds a state, the mapper reports
`unknown` rather than mis-classifying — a deliberate fail-safe, not an oversight.

## 6. External surfaces

`GET /channels` returns two additional rows. Additive; existing consumers reading known ids are
unaffected. No endpoint added, no config key, no behaviour change to messaging itself.

## 7. Multi-machine posture

**Machine-local by design for iMessage**, and this is a real property rather than a shortcut: the
backend it talks to runs on this host, so the channel genuinely exists only where that backend is.
That is recorded in the row's own `cost` text so a caller choosing it knows the work will not survive
this machine going away.

WhatsApp is pairing-bound to the operator's phone through whichever host holds the session — the same
locality. Neither introduces replicated state; both are per-host reads of a per-host adapter, and a
cross-machine merged view would be actively misleading since another machine's link says nothing
about this one's.

## 8. Rollback cost

Trivial: remove the two rows, the two mappers, the two context fields and the route wiring, and
restore the integration test's expected set. No persisted state, no schema, no migration. Rolling back
re-opens the stated gap, so it should carry a reason.
