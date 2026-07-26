## Tone-advisory remediation is now a runnable command (and a misplaced flag is refused, not sent)

**Audience:** agent-only. **Maturity:** stable.

When the outbound tone gate nudges a message, its advisory tells the sender how to
re-run. It named only the FLAGS (`--tone-complied RULE --tone-decision-ref REF`)
without saying where they go — and `telegram-reply.sh` parses flags only BEFORE the
positional topic id, breaking its parse loop at the first positional.

So the natural reading, `telegram-reply.sh TOPIC --tone-complied RULE`, silently
treated the flags as the MESSAGE TEXT (stdin ignored) and sent control text to the
user's conversation. The gate then reviewed that control text and issued a second,
nonsensical advisory — which reads like the gate malfunctioning rather than a usage
error.

Two changes:

1. **The advisory now prints the full runnable command**, flags before the topic id,
   for both the AGREE and DISAGREE paths.
2. **A known flag appearing after the topic id is refused** with exit 2, naming the
   flag and showing the corrected order — instead of being swallowed as message text.

Found by hitting it live on the first real advisory after the advisory migration
shipped. Migration parity: the outgoing template SHA is recorded in the
prior-shipped set, so deployed copies upgrade instead of producing a `.new` candidate.
