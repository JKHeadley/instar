# Visible automated mentor delivery — ELI16

The mentor and mentee are Telegram bots, and Telegram does not deliver one bot's message to another bot. Instar therefore uses a local server-to-server inbox when both agents are on the same machine. That transport correctly delivers the mentor's prompt, but it is invisible in the Telegram group. The operator sees the mentee answer something that never appeared in chat, which makes the exchange look incoherent.

This change keeps the local inbox as the one authoritative delivery path and adds a separate visible mirror only after the inbox has confirmed success. The mirror uses the mentor's already-configured bot and the same resolved mentor topic. If the mirror is disabled, not configured, or fails, the prompt remains delivered exactly as before: the return value, delivery ledger, outstanding-prompt tracking, and anti-ping-pong protections do not change.

The mirror's child setting is fleet-on only inside the existing dark mentor gate. It is not a new dark-feature gate, so the hand-audited set of dark defaults stays unchanged.

Telegram limits a message to 4096 characters, including labels and part markers. A pure chunk planner accounts for all overhead, prefers line boundaries, labels every part `[mentor] (i/N)`, preserves the original body byte-for-byte for ordinary multi-part prompts, and caps output at three messages. Pathological prompts end with an honest note that chat was shortened while the full prompt was delivered through the inbox. A mid-sequence error stops immediately, logs how many parts landed, and emits one degradation record without retrying.

The mentee-reply direction has no equivalent sender-bot plumbing at this chokepoint, so this change does not manufacture a second transport. That remaining visible-reply channel gap stays tracked by framework issue `mentor-guardian-drive-channel-gap`; the invisible mentor-prompt defect is tracked by `mentor-drive-invisible-prompts`.
