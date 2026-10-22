## What Changed

When an outbound reply cannot be sent, the agent keeps it and raises an attention
item saying it "is held durably and retried on the recovery schedule". Two
different kinds of hold shared that sentence, and for one of them it was false.

A **forwarded** hold — the reply is handed to the machine holding the serving
lease, and the handover fails — genuinely is retried, and often succeeds.

A **direct-path** hold is taken when this machine sealed the record before
discovering it does not hold the lease. A sealed record is bound to the machine
that produced it, so it **cannot be forwarded at all**. Nothing retries it. It can
only be sent if the lease returns to that machine, and otherwise it expires.

The direct-path notice now says exactly that. Delivery behaviour is unchanged.

## Evidence

- Measured from the held-origin audit on one agent by grouping every operation by
  its recorded lifecycle: **152 direct-path operations, 0 ever retried, 0 ever
  sent, 133 expired undelivered** — the oldest eleven days old. Every one had
  produced a notice saying it was being retried.
- By contrast, every forwarded hold in the same audit (30 operations) did enter
  recovery, and none expired.
- `tests/unit/held-notice-honesty.test.ts` — 7 assertions on the wording and the
  wiring, including that exactly one call site claims the direct path and that it
  is the direct-path observer. Canary-verified: reverting the source change fails
  6 of the 7.
- Side-effects review: `upgrades/side-effects/held-notice-honesty.md`
- Plain-English overview: `docs/specs/held-notice-honesty.eli16.md`

## What to Tell Your User

If your agent ever tells you a reply is stuck, the notice now distinguishes
between one it is retrying and one it cannot send at all. Previously both said a
retry was coming, which made the second kind look like something to wait out — and
waiting is exactly what does not help, since those expire undelivered unless the
right to speak returns to that machine.

## Summary of New Capabilities

None — this corrects the wording of an existing notice. No delivery behaviour
changes; the same replies are held, retried or expired as before.
