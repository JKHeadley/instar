# Measuring startup tokens for session continuity

The session continuity review checks whether recent work left handoffs, memory updates, or commits. Six saved Claude Code runs used the local Skill tool and Bash. Their median first-request input was about 81,013 tokens, including cached input.

The trial starts disabled. Baseline mode measures the normal launch. Treatment mode measures a supported Claude launch with an empty project integration list. Both keep Bash and Skill and use the original review and schedule. Missing prerequisites keep the ordinary launch. An explicit job policy keeps priority, and no automatic second copy of the review is started.

Authenticated job history shows the variant and its first measured request. Usage is unknown if a transcript cannot be matched. The replay covers a long session that left no artifact, which should result in a proposal, and one that left an artifact, which should stay quiet. The test simulates the tool path. Checking actual model judgments and savings requires a live trial after verification.
