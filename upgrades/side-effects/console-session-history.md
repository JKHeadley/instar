# Side effects: console session History (conversation record)

## Change
- `GET /sessions/:name/transcript?before=&limit=` (Bearer) returns a page of a recorded
  session's conversation (user text, assistant text, one line per tool call), newest page
  first, read backward from a byte cursor in 512 KB chunks (≤ 32 MB scanned per call, ≤ 500
  entries, 4,000 chars per entry). With `machineId` naming another machine it relays the read
  to that machine. The transcript is found under the session's own account config home, then
  the default home, then each pool account's home.
- Console: a Live / History switch on an open session. History loads the newest page and
  older pages on scroll-up, with "The start of this conversation." at the top.

Cause found: interactive sessions run in tmux's alternate screen (`alternate_on=1`,
`history_size=0` measured on 2026-11-01), so terminal scrollback is empty and the old
"load earlier output" path could never go further back than one screen.

1. **Over-block** — none; read-only.
2. **Under-block** — grok/pi sessions have no mapped transcript and answer "no conversation
   record yet". Subagent (sidechain) turns are not shown.
3. **Level fit** — reads the framework's own record through the existing path resolver.
4. **Signal vs authority** — no decision point.
5. **Interactions** — none with the live terminal stream; the switch only hides one box.
6. **External surfaces** — exposes conversation text to the Bearer holder, who can already
   watch and type into the same session.
7. **Multi-machine** — proxied-on-read: a remote session's history is read on its owner.
8. **Rollback** — revert; no state.

## 6b. Operator-surface quality
1. Primary action stays the live session; History is one tap beside Live.
2. No raw internals: messages read as text; tool calls are one muted line.
3. Nothing destructive.
4. Phone width: bubbles wrap, the switch is two chips, failures say "Can't tell" with the reason.
