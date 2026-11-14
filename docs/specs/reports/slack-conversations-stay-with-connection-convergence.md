# Convergence report: Slack conversations stay with their Slack connection (part 3a)

This took two review rounds, plus the part 3 review that split this fix out. Each was done by an independent reviewer subagent that read the spec against the code. Round 2 found no design defects and one code bug, now fixed and tested. No cross-model pass ran: the change only adds refusals at existing chokepoints.

## ELI10 overview

A Slack conversation can only be answered from the machine that holds your Slack connection. Moving one used to leave two sessions answering it. Now every way a move can start refuses it, and a move that was already half-done is undone by the machine that owns the conversation.

## What the rounds changed

- **Part 3 review (split).** The refusal moved into the drain runner, so every mover that drains is covered, not only `/pool/transfer`.
- **Round 1.**
  - The pin reconciler, the one mover that doesn't drain, now skips Slack pins.
  - `/pool/transfer` stops on the drain's refusal instead of falling through to the pin.
  - The key grammar reuses `SLACK_CHANNEL_ID_RE`.
  - The spec names the paths it deliberately leaves alone (stale-owner release, WS4 inbound) and the limits with mixed versions.
- **Round 2.**
  - A Slack record caught mid-transfer is aborted back by its owner and never claimed.
  - A leftover Slack pin reports why it's ignored.

| Round | Design defects | Code issues | Changes |
|---|---|---|---|
| part 3 review | (scope) | — | refusal moved into the drain runner |
| 1 | 2 | 1 | reconciler skip, stop on refusal, grammar |
| 2 | 0 | 1 | mid-transfer abort, pin state reason |

## Remaining, by design

- An older owner machine still splits on a mesh drain until it updates.
- An older lease holder may still write a pin after a newer owner's refusal; a newer owner's reconciler ignores it.
