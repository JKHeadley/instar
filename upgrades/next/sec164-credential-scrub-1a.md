# Live keys are masked in the agent's own logs

<!-- bump: patch -->

## What Changed

SEC-164, part 1a. One shared check now finds live keys of the kinds the outbound credential wall refuses, and the server's and lifeline's own output use it. The wall and the dashboard's browser copy decide exactly as before, and tests keep all three in step. On a development agent (the `security.credentialScrub.enabled` switch, dev-gated), the server's and lifeline's standard output and error, and the server's own log file, have such keys replaced with `[credential removed]` before they are written. The Telegram bot-key pattern now also matches the form used inside a Telegram address. Masking new incoming messages, copies sent between machines, and session records come in the next parts.

## What to Tell Your User

- **Keys stay out of my logs**: "If a key ever shows up in my own logs, I now blank it out before it is written, so nobody has to be told about it or change it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Live keys masked in the server's and lifeline's logs | Automatic on development agents; the switch is `security.credentialScrub.enabled` |

## Evidence

- `tests/unit/sec164-credential-spans.test.ts`: the shared check finds each form (alone, inside a Telegram address, with padding after it, with a zero-width character inside it, a private-key block), leaves ordinary text alone, masks with one marker and never reports values; the wrapper masks a key split across two writes and passes text through when off; it is installed only by the two start commands, never by the MCP tool server.
- The wall's existing tests pass unchanged. The dashboard parity test gained four cases (tag characters inside a key, two kinds in one message, the Telegram address form, and a `robot` prefix that is not a key) and passes.
