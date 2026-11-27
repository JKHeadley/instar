# Convergence report: the minimum-build fence (piece 2c)

**Spec:** `docs/specs/identity-security-piece2c-minimum-build-fence.md`
**Iterations:** 6. Internal security reviews, one cross-model round (GPT-6.2 Astra on the Headley Codex account) and the constitution check.

## In plain words

Once you set up your phone, a computer running an old version of Instar could keep following the old rules. This piece makes sure every computer is confirmed on a new enough version before your phone can be set up. It refuses old versions joining or being installed afterwards, and keeps the ownership ledger only on computers that are confirmed. Refusing an old computer the job of being in charge, or the work it would be sent, became its own next step (2d), and your phone setup waits for that too.

## Findings by round

| Round | Design findings | What changed |
|---|---|---|
| 1 | 6 | builds saved across restarts; readiness against the value to be written; the fence is 2a's policy; join and downgrade refused; refusal at choke points; separate lease input |
| 2 | 5 | lease and routing refusal cut into piece 2d (refusing at the network level makes a machine look dead and invites a lease fight) |
| 3 | 1 | Phone-level enrolment waits for 2d too |
| Constitution + Astra | 2 standards + 5 | evidence kept apart from access; four peer states (silence is unconfirmed, never below); a per-level floor table; readiness on the lease holder, rechecked at commit; live guards checked, not a release number |
| 5 | 1 | the fence in force comes from the record only; the table validates writes and reports a due raise |
| 6 | 0 | converged |

## What the design guarantees

- **No phone setup** while any computer is unconfirmed or old, or while the guards that level needs aren't running on every computer.
- **Nothing refused on missing evidence.** A sleeping or restarting computer is "unconfirmed", never "old".
- **A bad fence value never loosens the fence.**
- **One notice,** from the computer in charge.

## Left for later

- Piece 2d: refusing an old computer the lease and routing.
- Piece 3: enrolment, which checks readiness and live guards and writes the fence.
