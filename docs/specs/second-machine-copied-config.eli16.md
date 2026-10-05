# ELI16 — a second machine no longer goes silent because of state copied from the first

## What happened

Luna (the `sagemind` agent) was brought up on a second machine, a Mac Studio, next to Justin's laptop. When the Studio took over as the machine in charge, nothing Luna wrote could reach Telegram. Every reply was refused with `invalid-origin-token` (instar#2122).

Two pieces of state had been copied from the laptop. Each looked healthy, and each did damage on its own.

1. **A Claude program path that does not exist on the Studio.** The config file names where the Claude program lives (`sessions.claudePath`). The laptop's value, `/opt/homebrew/bin/claude`, was copied over, but on the Studio Claude lives at `/usr/local/bin/claude`. Instar used the configured path without checking it. Every Claude session on the Studio died the instant it started. When a session dies, Instar cancels that session's permission to send Telegram messages, so the reply it was about to send was refused. The Studio's own log shows the pattern: 34 sessions reported "died during startup", and they stopped once the path was corrected by hand.

2. **A removed machine identity that still counted as active.** The Studio was paired twice. Its first identity was removed, but the copy of the machine list on the Studio recorded the removal date while still saying "active". Instar trusted the "active" word alone, so it kept treating the removed identity as a live peer. That identity's network addresses are the Studio's own, so the Studio kept sending cross-machine checks to itself, and they were rejected as addressed to someone else (hundreds of times a day in the log).

## What changes

- If `sessions.claudePath` points at a file that provably does not exist on this machine, Instar ignores it, uses the Claude program it can find, and prints a warning naming both paths. If it finds no Claude program on the machine at all, the configured path is kept as before (with a warning), so nothing changes on a machine that has no Claude. A path that exists, a bare command name, or a path that cannot be checked is kept exactly as configured.
- A machine entry counts as active only if it says "active" **and** has no removal date. The machine list, the "who is awake" lookup, nickname lookup, the `machine` CLI status view, the passkey machine-state check, and the origin audit's list of machines all use this one rule. Instar's own boot-time identity recovery already used it.

## What does not change

Nothing changes for an agent on one machine, or for any config whose Claude path exists. No data is rewritten: the registry file is read more strictly, not edited.

## What you need to decide

Nothing. This is a bug fix; the remaining setup gaps from #2122 are tracked in that issue.
