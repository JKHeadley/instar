# The same-machine route proves who is sending — plain-English overview

Two agents on the same computer can talk in two ways. One goes out over the internet through a relay server. The other is a shortcut: one agent hands the message straight to the other agent's server on the same machine.

The relay way proves who is sending. Every message carries a digital signature made with the sender's private key, and the receiver checks it before reading the message.

The shortcut never proved anything. The sender wrote its own name into the message, and the receiver believed it. The only thing the receiver checked was a password-like token that any program on the same computer could read. An earlier change made the shortcut look the sender's name up in a trust list, but it still took the name on faith, and said so.

This change closes that gap in two steps.

**Step one: everybody signs.** Every message an agent sends over the shortcut now carries a signature made with the identity key that agent already has. An agent never signs under a name that is not its own. An older receiver that does not know about the signature ignores it, so agents can update in any order.

**Step two: the receiver checks, behind a switch.** The receiver looks up the sender's name in its own list of agents it has met and checks the signature against the public key it has on record for that name. It also checks that the message was addressed to it, that it is less than ten minutes old, and that it is not an exact repeat of one it already accepted. If it has no key on record for the sender, it fetches the key itself from the sender's own server on that computer and keeps it in memory (at most five tries per sender). It never writes that key into its saved list of agents, and it never swaps out a key it already holds, because whatever program happens to answer on that port must not be able to take over a known agent's name.

The switch has three positions:

- **Off.** Nothing is checked. This is where every ordinary agent starts.
- **Watch-only.** Every message is checked, and every one that would fail is logged and counted with the reason, but everything is still delivered as before. This is where a development agent starts.
- **Enforcing.** A message that fails the check is refused before it is recorded anywhere, with an answer that says which check failed and whether the fix is on the sender's side or the receiver's. The message can still travel over the relay.

The setting is `threadline.localRouteSignature`. `enabled: true` turns the check on, and `dryRun: false` moves it from watch-only to enforcing. Each agent says which position it is in on its health page, so another agent (Dawn's backup route, which is waiting for this) can see when the proof is really being enforced instead of guessing. A sender that must never deliver an unproven message can also say so on each request (a header, `X-Instar-Require-Signature: v1`); a receiver that is not enforcing refuses that request.

Two side doors are closed for the enforcing position. One of the two sending programs used to park a refused message in an offline folder that the receiver empties at its next start without any check, so a refused message could sneak in later. Now a refusal is final on that path: the send fails and says why. And when the receiver empties that folder, it applies the same signature check. A parked message it cannot prove is left in the folder, not deleted. The receiver tries once more five minutes after it starts, when the other agents are up and their keys can be fetched, and only then removes anything that is still unproven and more than seven days old. The sender is not told that its parked message was held or removed; that gap is written down as a tracked item.

**What it costs.** While watch-only, nothing. Once a receiver is enforcing, a sender on the same computer that is still on an older version (and so does not sign) has its messages go over the relay, or the send fails and says so. Every check writes one line to its own small log file, and the last 24 hours of that file show how many such messages there are before anyone flips the switch. If the file does not cover the full 24 hours, the answer counts as unknown and the switch stays where it is.

**Limits, said plainly.** The check does not stop a program running as the same user on the same computer, because such a program can read every agent's private key anyway. The key on record was taken on first contact from the agent's own server on that computer, so the signature proves "this is the same agent whose key I recorded," not a stronger kind of identity; mutual verification is a separate feature. And until someone moves an agent to enforcing, the check protects nothing on that agent. It only measures.

**What ships now.** Signing on every agent. The check itself, watch-only on development agents and off everywhere else.

**What comes next.** Echo moves to enforcing after a day of clean watch-only numbers, and Dawn's backup route switches on against that. Turning it on for every agent is a later, separate change.

**Status.** Approved for building under the operator's directive for this commitment (Justin, Telegram topic 9210, 2026-10-09). The watch-only-first rollout was set by the supervising session's brief on 2026-10-10.
