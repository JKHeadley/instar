# Side-effects review for Claude Code compaction recovery

The approved layered-summaries spec, section 9.1, requires observed delivery of the recovery block. Studio recorded the built-in SessionStart compact hook cancelled at 5,023 milliseconds against a 5,000-millisecond timeout. Several sequential optional reads each had their own deadline and four had none. An isolated localhost server reproduced the cancellation at five seconds and delivered a recovery block with a longer budget.

1. Over-block. Only the built-in compact registration with the old default timeout is migrated. Startup, resume, and intentionally configured timeouts are preserved.
2. Under-block. A stalled optional HTTP read is bounded. If execution exceeds the overall 45-second deadline, the existing canary can still record a failure from the missing recovery evidence.
3. Abstraction. Registration owns the total deadline and each HTTP call owns its individual deadline. The same migration used by canary repair updates the installed registration.
4. Signal versus authority. The existing canary continues to judge what the harness delivered and the existing shortening safeguard consumes that evidence. No failure record is rewritten.
5. Interactions. The aggregate local HTTP allowance fits within the new deadline. On a slow host, a compaction may wait longer for context. Other Claude lifecycle hooks and the Codex registration keep their previous timeouts.
6. External surfaces. The recovery script still calls its existing localhost endpoints. There is no new route, recipient or transmitted payload.
7. Multi-machine posture. Each machine installs and uses the recovery hook against its local server. No cross-machine state migration is required.
8. Rollback. Restore the previous script and registration through the ordinary update path. An installed 45-second registration can be restored to five seconds explicitly if needed.
