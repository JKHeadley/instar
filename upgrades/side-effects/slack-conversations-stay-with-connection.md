# Side effects: Slack conversations stay with their Slack connection (part 3a)

Change: a Slack conversation's session is never moved to another machine. Every attempt is refused before anything happens:
- the drain runner refuses Slack keys for every mover that drains;
- the pin reconciler, the one mover that doesn't drain, skips Slack pins;
- `POST /pool/transfer` says so in words, and stops on the drain's refusal;
- the overload shed never picks a Slack conversation. Before this, a move left two live sessions on one Slack conversation, because the drain's seams read `Number(key)` and treated the live Slack session as nothing to close. **Tier 2**: it changes the drain runner, which every move path uses. Spec: `docs/specs/slack-conversations-stay-with-connection.md`.

1. **Over-block.** An operator can no longer move a Slack conversation. That never worked: it split the conversation. Slack still re-homes through an authenticated inbound on another machine connected to the same workspace (WS4), unchanged.
2. **Under-block.**
   - An older owner machine still splits on a mesh drain until it updates.
   - An older lease holder may still write a pin after a newer owner's refusal. A newer owner's reconciler ignores that pin.
   - Stale-owner release and WS4 inbound placement are deliberately unchanged: there is no live session to split, or the re-home is the authenticated Slack path.
   - A Slack record left `transferring` mid-drain from before the update now recovers through the existing transferring timeout, not by resuming the drain.
3. **Level-of-abstraction fit.** One check sits at the drain chokepoint. The route check exists only for the words, and the shed filter only so the shed stops picking Slack keys.
4. **Signal vs authority.** No judgment: an exact key grammar (`isSlackConversationKey`, raw `C…`/`D…`/`G…` with an optional `:<thread ts>`, or `slack:`).
5. **Interactions.**
   - The phone's new Move state `stays` is additive. The app shows the reason for any state it doesn't know, so no schema bump is needed.
   - The new drain status `refused-slack-stays` is a refusal. Callers already treat refusals as "nothing moved".
   - `isSlackSessionKey`, used by the forward bridge and still non-numeric, is unchanged here. Part 3b tightens it.
6. **External surfaces.**
   - `/pool/transfer` answers 409 `slack-stays-with-connection` with a sentence.
   - The phone's controls answer gives Slack a Move row of `state: 'stays'` with that sentence.
7. **Multi-machine posture.** This enforces the Slack reply spec's named machine-local exception (`physical-credential-locality`) on the transfer side, where it was planned but never built.
8. **Rollback.** Revert. Slack moves split again.

## 6b. Operator-surface quality

1. **Primary action first.** The Move row shows one sentence instead of a move that can't work.
2. **No raw internals.** The machine is named by nickname. The refusal is a sentence.
3. **Destructive de-emphasized.** Nothing destructive is added; a destructive split is removed.
4. **Plain at phone width.** One sentence.

## Class-Closure Declaration

- **unbounded-self-action — closure: n/a.** This adds a refusal and no action. The overload shed now skips Slack keys, so it can never act on one at all.
