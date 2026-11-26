# Side-effects review for Codex conversation recovery

The approved layered-summaries spec, section 9.6, already authorizes delivering the first verified recovery packet through the topic prompt hook. Studio reported zero offers since restart. The hook only requested an offer inside its legacy context fallback. A real shell and HTTP regression confirmed that a successful context read skipped both recovery requests.

1. Over-block. A suppressed prompt still leaves before the recovery offer. Credential and session checks are unchanged.
2. Under-block. An unavailable or refused offer leaves the original output path in place. The canary still uses transcript evidence to decide whether recovery reached the model.
3. Abstraction. The delivery hook chooses its own output. The existing service owns staging, session binding, byte verification, and deduplication.
4. Signal versus authority. The existing authenticated service decides whether to offer the packet. The hook acknowledges printed output. The acknowledgement cannot make the canary report recovery on its own.
5. Interactions. A successful offer replaces the ordinary context and returns. The timeout covers the optional 3-second clock request, 4-second context request, 3-second offer and 1-second acknowledgement, with time for shell overhead. Fresh init and update use the same hook generator.
6. External surfaces. The hook adds a bounded localhost request on eligible Codex topic prompts. Existing Claude Code prompts bypass it. There is no new route or network destination.
7. Multi-machine posture. The hook addresses its local service and the service binds recovery to that machine's live topic session. The repair does not mutate older canary evidence or change context-shortening eligibility.
8. Rollback. Revert the source changes and regenerate installed hooks through the normal update path. No state conversion is required.

Independent review confirmed suppression, authentication, and installation parity. The reviewer requested allowance for the optional clock request in the hook timeout. The final timeout is 15 seconds, exceeding the 11 seconds allocated to the four sequential modern-path requests.
