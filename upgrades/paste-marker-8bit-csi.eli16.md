# ELI16 — the same instruction, spelled two ways, and we only blocked one

When a message is typed into a session, it gets wrapped in an invisible "here comes a pasted block"
marker and a matching "that's the end of the block" marker. Anything between them is treated as text
rather than as commands.

So a message containing its own copy of the *end* marker could close the block early, and whatever
followed would be read as commands rather than text. That was spotted before and blocked: the code
strips those markers out of any message before wrapping it.

**But that control sequence can be written two ways** — a common two-character spelling and a rarely
used one-character spelling that means exactly the same thing. The code only removed the two-character
form. The one-character form went through untouched.

The comment above it said it strips "any embedded markers". It stripped one spelling of them.

**The fix removes both spellings.** Nothing else changes — a message that merely *mentions* `[201~` as
ordinary text is still delivered exactly as written, which one of the new tests checks.

**What I am not claiming.** Whether the one-character spelling actually does anything depends on how
the terminal is configured, and I have not tested that. What I did test is that the code does not do
what its comment says. That is worth fixing regardless — this is a defence-in-depth guard, and a
terminal upgrade could change the answer without anyone revisiting this line.
