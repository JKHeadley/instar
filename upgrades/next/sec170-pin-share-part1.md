# One PIN guess limit for the whole agent, split between its computers (part 1 of 2)

<!-- bump: patch -->

## What Changed

SEC-170, part 1 of 2 (`docs/specs/pool-wide-pin-budget.md`, approved). The unknown-browser PIN budget (20 wrong guesses per 5 minutes, `GLOBAL_PIN_KEY`) was enforced per machine, so knowing N addresses gave N × 20 guesses at the one shared PIN. With `security.pinBudget.poolWide` on (dev-gated: on for a development agent, off on the fleet; file-only), each machine now enforces a fixed share of the 20, computed from its own registry: `floor(20 / N)` plus one for the first `20 mod N` machines in id order, so the shares sum to 20.

- New `PinShareProvider` (`src/core/PinShare.ts`) stores the applied share in `state/pin-share.json` and a second copy, flushed to disk. It lowers the share at once when the registry grows, never raises it on its own (raises need part 2's agreement), and refuses (share 0) if both copies are damaged.
- `POST /dashboard/unlock`, `POST /dashboard/session/step-up` and the email-code confirm read the cap from the provider.
- With the switch on, `PinAttemptStore` flushes its writes, and a failed write of the shared key refuses new browsers until a write succeeds. With it off, behaviour is unchanged.
- The brute-force alert, with the switch on, fires when a spent share was spent by more than one source or in two windows in a row (30-minute cooldown), since a small share can be spent by a few typos.
- Each machine advertises `pinBudgetPoolWide` and `pinShare` in its capacity heartbeat.
- Ladder entry `pinBudgetPoolWide`.

Part 2 of 2 adds the agreement protocol: raises after every machine acknowledges, the hand-down to a newly paired machine, recovery from lost records, the owner's "gone for good", and the single silent-machines notice. Until then: a newly paired machine takes its own equal share from its registry, so while registries catch up the shares can briefly sum above 20 (the transient residual named in spec §6); a retirement raises nobody; and if both copies of `pin-share.json` are deleted (a state wipe or restore), the machine starts a fresh first table, which can raise a share it had lowered. Part 2's recovery rule closes both.

## What to Tell Your User

- **Tighter PIN protection across computers**: "Strangers now get 20 PIN guesses every five minutes across all my computers together, not 20 on each one. Your usual ways in are unchanged."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Per-machine PIN share | Automatic on development agents (`security.pinBudget.poolWide`) |

## Evidence

- `tests/unit/sec170-pin-share.test.ts`: shares for N = 1, 2, 3, 5, 20, 21; always sum to 20; adding a machine never raises a share (N up to 40, every position); first table, lowering, no raise on retirement, second-copy recovery, both copies lost gives 0, unknown membership.
- `tests/unit/sec170-pin-store-strict.test.ts`: on, a failed write refuses until a write succeeds; off, unchanged; counts survive restart; the email-code check refuses after the share.
- `tests/e2e/sec170-pin-share-alive.test.ts`: a real server for a five-machine agent refuses the 5th unknown browser, while a browser that unlocked before and a local request still unlock; with the switch off, today's budget.
