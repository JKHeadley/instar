# Convergence report: the fence, part two (piece 2d)

**Spec:** `docs/specs/identity-security-piece2d-fence-lease-routing.md`
**Iterations:** 7. Internal reviews, a redesign after the constitution check and GPT-6.2 Astra (Headley Codex account), then two more internal rounds.

## In plain words

After you set up your phone, a computer running an old version of Instar doesn't know the new rules. The first designs tried to chase every way work could reach such a computer: move its conversations, hold its messages, keep taking charge back from it. Each fix opened a new hole: answering twice, losing messages, endless back-and-forth over who's in charge.

The constitution check and the second AI reviewer pointed to a simpler answer. While any computer runs an old version, the agent holds risky actions everywhere and tells you once which computer to update. The updated computers stop sending it new work or anything secret. They take charge back a few times a day at most. Its existing conversations carry on where they are.

## Findings by round

| Round | Design findings | What changed |
|---|---|---|
| 1 | 4 | its own lease brake; hold instead of move; signed version evidence; every mesh verb classified |
| 2 | 2 | a dedicated message hold; direction matters (work from it is accepted) |
| 3 | 1 | the hold's custody follows the lease |
| 4 | 0 | converged on the first design |
| Constitution + Astra | 8 standards + 7 | redesign: one agent-wide hold; a settling takeover budget; no custom message store; existing conversations unmoved; one notice updated in place; live graduation with piece 3 |
| 5 | 3 | retiring an old machine passes the hold; message delivery continues for topics it owns; ownership arriving through the journal from it is dropped |
| 6 | 0 | converged |

## What the design guarantees

- **No risky action** on any updated computer while an old computer is part of the agent.
- **No endless contest** over who is in charge.
- **No double replies,** and no lost messages.
- **One clear message** to the owner, closed when resolved.

## Left for later

Piece 3 checks the live guards before enrolment. Its live proof on a mixed-version pair is this piece's graduation.
