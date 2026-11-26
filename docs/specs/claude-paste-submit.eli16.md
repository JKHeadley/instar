# When a pasted message waits for Enter

Instar delivers some messages by pasting them into Claude Code and pressing Enter. Finishing the paste and being ready to submit it can happen at different times. If Claude misses Enter, the words stay in the input box. Instar already checks for that and can press Enter again. On a pane it identifies as Claude Code, it now gives a bracketed paste half a second longer before the first Enter. A short message typed on a single line uses its usual timing.

Claude also shows old messages with the same arrow it uses for the current input box. If the first message was answered quickly, a check could see the old arrow and keep pressing Enter while reporting that the message never arrived. The check now looks for the start of the pasted text in the current input. It can recognize a marker that spans two lines. A genuinely stranded draft still gets the existing bounded recovery attempts when Claude is idle. An empty input box after an answer gives the verifier no reason to press a key.

The tests use a private simulated terminal. They count what Instar sends and what the terminal accepts. How often the added half-second prevents a missed Enter on a live Claude installation remains unmeasured.

The follow-up uses Instar’s shared identifiers for Claude and Codex when selecting the paste delay and checking the composer. This keeps engine names consistent with the rest of the application and leaves the timing and the recovery behavior described above intact.
