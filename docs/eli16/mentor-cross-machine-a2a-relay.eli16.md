# Cross-machine mentor delivery — ELI16

Telegram bots cannot receive messages written by other Telegram bots. That means a mentor bot can put a prompt into the visible topic for the human record, but the mentee bot will never receive that prompt live. Treating the visible post as delivery made the mentor believe a cycle had started when the mentee had heard nothing.

Instar already solved this when mentor and mentee run on the same computer: it sends the prompt directly into the mentee's authenticated A2A inbox, then mirrors the accepted prompt into Telegram. This change carries that exact inbox message over Instar's signed machine-to-machine channel when the mentee lives on another machine.

The receiving machine first verifies the sender's cryptographic machine identity, freshness, recipient binding, and replay nonce. It then checks that the configured mentor agent is allowed to come from that specific machine. Only after those checks does the existing inbox validate the A2A marker, mentor role, target agent, and mentor bot ID. A machine that merely writes “from Echo” in its payload gains no authority.

Telegram remains useful as the visible supervision record, but it is never proof of delivery. The mirror is emitted only after the mentee inbox says it accepted the prompt. If the signed relay times out, targets the wrong agent, comes from the wrong machine, or fails the inbox allowlist, the mentor records a delivery failure and does not mark an outstanding prompt as sent.

## ELI16 — practical result

Echo can drive Codey live across machines while Justin watches the same prompt in Telegram. The private delivery path does the real work; Telegram shows what happened. A visible message alone can no longer create a phantom mentorship cycle.
