<!-- bump: minor -->

## What Changed

Added the ReviewExchange protocol — the structured way two mandate-named agents complete
a mutual code-review sign-off without the operator relaying messages between them. One
exchange tracks one review package (content-addressed by checksum, fixed at creation)
through a strict linear lifecycle: proposed, delivered, verdict recorded, complete — or
changes-requested, which is terminal so a stale approval can never be replayed onto
reworked code. Both sign-offs — the reviewing peer's authenticated approval and the
owner's countersignature — are checked against the operator's coordination mandate
before acceptance, and every accepted signature stores the audit reference of the gate
decision that authorized it. With no mandate issued, every sign-off refuses: the
protocol inherits deny-by-default and ships inert.

## What to Tell Your User

Your agent can now run a real code review with a partner agent under the permission
slip you issue — no more relaying review messages between them yourself. The agents
deliver the code package, record the reviewer's verdict, and counter-sign, and every
step is checked against your permission slip and written to the same tamper-evident
log. If you revoke the slip mid-review, the review stops on the spot. Until you issue
a slip, nothing changes — every review step refuses by default.

## Summary of New Capabilities

- Create a review exchange for an artifact under a mandate, content-addressed so the
  signatures bind to exactly the code that was reviewed.
- Record delivery, the peer's authenticated verdict, and the owner's countersignature —
  with both sign-offs evaluated through the mandate gate and refused on any deny.
- Inspect exchanges and their signatures, each carrying the audit reference of the
  gate decision that authorized it.
- Maturity: stable engine and routes; ships inert (deny-by-default) until the operator
  issues a mandate with the sign-code-review authority.
