<!-- bump: patch -->
## What Changed

External tool calls now follow the person's trust settings (trust journey stage 0, part C; docs/specs/trust-journey.md). The agent server, not the agent, now works out what each tool call does from its real name and input. Kinds of action the agent already used before this update keep exactly their old behaviour until the person changes them. A new kind of action, signing in with a stored password in the browser, or anything that speaks publicly first asks the person: a card listing the exact call goes to their direct chat, and the call runs only after they reply `approve <code>`. One approval covers that one call, and a changed or repeated call asks again. A kind the person has set to "Do it and show me" or "Just do it" runs without asking when its effect is clear. When the agent server cannot be reached, a governed call is refused instead of slipping through, while known reads and unchanged kinds keep working. Each admitted governed action gets an entry in a new outcome record. A trust settings file that cannot be read is rebuilt from the durable change log, keeping every restriction. Instar's own internal parity check is now a system service and no longer needs a trust setting.

## What to Tell Your User

- "If I need to do something new on your behalf, like using a service for the first time or signing in with a saved password, I'll send you a card in our private chat showing exactly what I want to do. Reply with the code and I'll do it once. Everything I already did before keeps working as it did."
- "Anything that would post publicly in your name always comes to you first."

## Summary of New Capabilities

- Tool calls are classified by the agent server from their real name and input, and new or sensitive kinds ask the person first with a one-action card.
- Existing kinds keep their old behaviour; governed calls fail closed when the server cannot be reached.
- A rebuilt-from-log recovery for an unreadable trust settings file.

## Evidence

- `tests/unit/trust-journey-governed-effects.test.ts`, `tests/unit/trust-journey-corrupt-state.test.ts`, `tests/unit/hook-installation.test.ts`, `tests/integration/trust-governed-effects-routes.test.ts`.
- Live proof on a throwaway agent: see the PR.
