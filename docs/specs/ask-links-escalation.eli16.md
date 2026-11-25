# A stronger response when an ask repeats without its links

The trial starts from a confirmed finding about a message the agent already sent. The same message counts once for a given rule, even when multiple reviews report it. The first finding calls for a learning note, the second calls for a targeted reminder, and the third adds a draft check. Each rule has its own history.

At the draft-check step, the review tool can check a draft marked as containing an ask for the request section and its links. If the agent chooses to keep a draft that needs links, it records a short reason. That reason applies to the exact text and topic, so changing the draft requires a fresh check. The draft tool gives advice and does not decide whether a message can be sent.

This trial is off by default. The initial route accepts the ask-links rule and delivered agent replies only. It is ready for a reviewer to call on a test agent. Existing message sending and the current outbound review keep their behavior. The tests replay repeated findings, a different rule and a recorded override.
